import argparse
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'deploy/nas-auto-update/install.py'
spec = importlib.util.spec_from_file_location('nas_install', SCRIPT)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class FakePortainer:
    def __init__(self, *args):
        self.mutations = []
        self.files = {}
        self.containers = [{'Id': 'portainer-id', 'Names': ['/portainer'], 'State': 'running'}]
        self.volumes = []

    def request(self, path, method='GET', data=None):
        if path == '/stacks/19' and method == 'GET':
            return {'Id': 19, 'Name': 'operix', 'EndpointId': 3}
        raise AssertionError('Installer must not mutate any application stack')

    def docker(self, path, method='GET', data=None, **kwargs):
        if method != 'GET':
            self.mutations.append((path, method, data))
        if path.startswith('/images/'):
            return {'Os': 'linux', 'Architecture': 'amd64'}
        if path == '/containers/json?all=1':
            return self.containers
        if path == '/networks':
            return []
        if path == '/containers/portainer-id/json':
            return {'NetworkSettings': {'Networks': {'bridge': {}}}}
        if path == '/volumes':
            return {'Volumes': self.volumes}
        if path == '/volumes/create':
            self.volumes.append(data)
            return data
        if path.startswith('/containers/create?name='):
            return {'Id': 'init' if path.endswith('-install') else 'updater'}
        if path.endswith('/wait?condition=not-running'):
            return {'StatusCode': 0}
        if path == '/containers/updater/json':
            return {'State': {'Running': True}}
        if path.endswith('/start') or method == 'DELETE':
            return None
        raise AssertionError('Unexpected Docker API call: ' + path)

    def put_files(self, cid, files):
        self.files = files


class InstallerTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.config = self.root / 'config.json'
        self.config.write_text(json.dumps({'endpoint_id': 3, 'stack_id': 19,
                                          'stack_name': 'operix', 'network_mode': 'host',
                                          'poll_seconds': 60}))
        self.key = self.root / 'api-key'
        self.key.write_text('test-private-key')
        self.args = argparse.Namespace(config=self.config, key_file=self.key,
                                      portainer_url='http://nas:9000', portainer_container='portainer',
                                      runtime_image='python@sha256:' + 'a' * 64,
                                      health_ca=None, replace=False)

    def test_host_install_preserves_stack_networks_and_keeps_key_out_of_container_metadata(self):
        api = FakePortainer()
        output = io.StringIO()
        with patch.object(installer, 'Portainer', return_value=api), \
                patch.object(installer.time, 'sleep'), patch('sys.stdout', output):
            installer.install(self.args)
        created = next(data for path, method, data in api.mutations
                       if path == '/containers/create?name=operix-auto-update')
        self.assertEqual(created['HostConfig']['NetworkMode'], 'host')
        self.assertEqual(created['User'], '65532:65532')
        self.assertTrue(created['HostConfig']['ReadonlyRootfs'])
        self.assertEqual(created['HostConfig']['CapDrop'], ['ALL'])
        self.assertTrue(created['HostConfig']['Mounts'][0]['ReadOnly'])
        self.assertNotIn('PortBindings', created['HostConfig'])
        self.assertNotIn('NetworkingConfig', created)
        self.assertFalse(any(path.startswith('/networks/') for path, _, _ in api.mutations))
        self.assertNotIn('test-private-key', json.dumps(api.mutations) + output.getvalue())
        self.assertEqual(api.files['api-key'], b'test-private-key')
        self.assertEqual(json.loads(api.files['config.json'])['portainer_url'], 'http://127.0.0.1:9000')
        self.assertEqual({v['Name'] for v in api.volumes},
                         {'operix-auto-update-config', 'operix-auto-update-state'})

    def test_existing_updater_requires_explicit_replacement_and_is_not_removed(self):
        api = FakePortainer()
        api.containers.append({'Id': 'existing', 'Names': ['/operix-auto-update'], 'State': 'running'})
        with patch.object(installer, 'Portainer', return_value=api), self.assertRaises(RuntimeError):
            installer.install(self.args)
        self.assertEqual(api.mutations, [])

    def test_missing_ca_input_fails_before_any_mutation(self):
        cfg = json.loads(self.config.read_text())
        cfg['health_ca'] = '/config/health-ca.pem'
        self.config.write_text(json.dumps(cfg))
        api = FakePortainer()
        with patch.object(installer, 'Portainer', return_value=api), self.assertRaises(RuntimeError):
            installer.install(self.args)
        self.assertEqual(api.mutations, [])

    def test_secret_archive_is_private_and_owned_by_runtime_user(self):
        api = installer.Portainer('http://nas:9000', 'test-private-key', 3)
        with patch.object(api, 'docker') as docker:
            api.put_files('init', {'api-key': b'test-private-key'})
        args, kwargs = docker.call_args
        self.assertEqual(args[0], '/containers/init/archive?path=/config')
        with tarfile.open(fileobj=io.BytesIO(args[2])) as archive:
            key = archive.getmember('api-key')
            self.assertEqual((key.uid, key.gid, key.mode), (65532, 65532, 0o600))
            self.assertEqual(archive.extractfile(key).read(), b'test-private-key')


if __name__ == '__main__':
    unittest.main()
