#!/usr/bin/env python3
"""Install/update the NAS polling sidecar through an existing Portainer API key.

The supplied key file and target configuration stay outside the repository.
Only this sidecar, its two volumes, and its private control network are managed.
"""
import argparse
import io
import json
import pathlib
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request

NAME = 'operix-auto-update'
NETWORK = 'operix-deploy-control'
UID = 65532


class Portainer:
    def __init__(self, url, key, endpoint):
        self.url = url.rstrip('/') + '/api'
        self.key = key.strip()
        self.endpoint = endpoint

    def request(self, path, method='GET', data=None, raw=False, content_type='application/json'):
        headers = {'X-API-Key': self.key}
        if data is not None:
            if not isinstance(data, bytes):
                data = json.dumps(data).encode()
            headers['Content-Type'] = content_type
        req = urllib.request.Request(self.url + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=600) as response:
                body = response.read()
                return body if raw else (json.loads(body) if body else None)
        except urllib.error.HTTPError as error:
            raise RuntimeError(f'Portainer request failed: HTTP {error.code}') from None

    def docker(self, path, method='GET', data=None, **kwargs):
        return self.request(f'/endpoints/{self.endpoint}/docker' + path, method, data, **kwargs)

    def put_files(self, cid, files):
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode='w') as tar:
            for name, data in files.items():
                entry = tarfile.TarInfo(name)
                entry.size = len(data)
                entry.mode = 0o600
                entry.uid = UID
                entry.gid = UID
                tar.addfile(entry, io.BytesIO(data))
        self.docker(f'/containers/{cid}/archive?path=/config', 'PUT', archive.getvalue(),
                    raw=True, content_type='application/x-tar')


def install(args):
    config = json.loads(args.config.read_text())
    network_mode = config.get('network_mode', 'bridge')
    if network_mode not in ('bridge', 'host'):
        raise RuntimeError('Updater network mode must be bridge or host')
    key = args.key_file.read_text().strip()
    api = Portainer(args.portainer_url, key, config['endpoint_id'])
    stack = api.request(f"/stacks/{config['stack_id']}")
    if (stack['Name'], stack['EndpointId']) != (config['stack_name'], config['endpoint_id']):
        raise RuntimeError('Target stack identity does not match configuration')
    if '@sha256:' not in args.runtime_image:
        raise RuntimeError('Runtime image must be pinned by digest')
    if config.get('health_ca') and not args.health_ca:
        raise RuntimeError('Configured health CA requires --health-ca')
    health_ca = args.health_ca.read_bytes() if args.health_ca else None
    image = api.docker('/images/' + urllib.parse.quote(args.runtime_image, safe='') + '/json')
    if (image['Os'], image['Architecture']) != ('linux', 'amd64'):
        raise RuntimeError('Runtime image must be linux/amd64 and already present on NAS')
    containers = api.docker('/containers/json?all=1')
    portainers = [c for c in containers if '/' + args.portainer_container in c['Names']]
    if len(portainers) != 1:
        raise RuntimeError('Expected exactly one explicitly named Portainer container')
    portainer = portainers[0]
    existing = [c for c in containers if '/' + NAME in c['Names']]
    if existing and not args.replace:
        raise RuntimeError('Updater already exists; use --replace to install reviewed code')
    if existing:
        details = api.docker('/containers/' + existing[0]['Id'] + '/json')
        if details['Config'].get('Labels', {}).get('operix.scope') != 'auto-deployment':
            raise RuntimeError('Existing container is not the managed updater')
        if existing[0]['State'] == 'running':
            api.docker('/containers/' + existing[0]['Id'] + '/stop?t=30', 'POST')
        api.docker('/containers/' + existing[0]['Id'] + '?v=0', 'DELETE')
    labels = {'operix.scope': 'auto-deployment'}
    networks = api.docker('/networks')
    health_network = config.get('health_network')
    if health_network and not any(n['Name'] == health_network for n in networks):
        raise RuntimeError('Configured existing health network does not exist')
    matching = [n for n in networks if n['Name'] == NETWORK]
    if matching and network_mode == 'bridge':
        if matching[0].get('Labels', {}).get('operix.scope') != 'auto-deployment':
            raise RuntimeError('Control network name is already used by another owner')
    elif network_mode == 'bridge':
        api.docker('/networks/create', 'POST', {'Name': NETWORK, 'Driver': 'bridge', 'Labels': labels})
    details = api.docker('/containers/' + portainer['Id'] + '/json')
    if network_mode == 'bridge' and NETWORK not in details['NetworkSettings']['Networks']:
        api.docker('/networks/' + NETWORK + '/connect', 'POST', {
            'Container': portainer['Id'], 'EndpointConfig': {'Aliases': ['portainer']}})
    for suffix in ('config', 'state'):
        name = NAME + '-' + suffix
        volumes = api.docker('/volumes').get('Volumes') or []
        matching = [v for v in volumes if v['Name'] == name]
        if matching and matching[0].get('Labels', {}).get('operix.scope') != 'auto-deployment':
            raise RuntimeError('Updater volume name is already used by another owner')
        if not matching:
            api.docker('/volumes/create', 'POST', {'Name': name, 'Labels': labels})
    mounts = [{'Type': 'volume', 'Source': NAME + '-config', 'Target': '/config'},
              {'Type': 'volume', 'Source': NAME + '-state', 'Target': '/state'}]
    init = api.docker('/containers/create?name=' + NAME + '-install', 'POST', {
        'Image': args.runtime_image, 'Labels': labels,
        'Cmd': ['python3', '-c', 'import os; os.chown("/state",65532,65532); os.chmod("/state",0o700); os.chown("/config",65532,65532); os.chmod("/config",0o700)'],
        'HostConfig': {'NetworkMode': 'none', 'Mounts': mounts, 'Memory': 128 * 1024**2}})['Id']
    config['portainer_url'] = 'http://127.0.0.1:9000' if network_mode == 'host' else 'http://portainer:9000'
    try:
        if health_ca:
            config['health_ca'] = '/config/health-ca.pem'
        files = {'config.json': (json.dumps(config, indent=2) + '\n').encode(),
                 'api-key': key.encode(),
                 'updater.py': pathlib.Path(__file__).with_name('updater.py').read_bytes()}
        if health_ca:
            files['health-ca.pem'] = health_ca
        api.put_files(init, files)
        api.docker('/containers/' + init + '/start', 'POST')
        result = api.docker('/containers/' + init + '/wait?condition=not-running', 'POST')
        if result.get('StatusCode') != 0:
            raise RuntimeError('Unable to initialize private state directory')
    finally:
        api.docker('/containers/' + init + '?v=0', 'DELETE')
    mounts[0]['ReadOnly'] = True
    endpoints = {NETWORK: {}} if network_mode == 'bridge' else {}
    if health_network:
        endpoints[health_network] = {}
    container_config = {
        'Image': args.runtime_image, 'User': str(UID) + ':' + str(UID), 'Labels': labels,
        'Cmd': ['python3', '-u', '/config/updater.py', '--config', '/config/config.json', '--state', '/state'],
        'Env': ['PYTHONDONTWRITEBYTECODE=1'],
        'HostConfig': {'NetworkMode': 'host' if network_mode == 'host' else NETWORK, 'Mounts': mounts,
                       'Memory': 512 * 1024**2, 'CpuShares': 128,
                       'PidsLimit': 64, 'ReadonlyRootfs': True, 'CapDrop': ['ALL'],
                       'SecurityOpt': ['no-new-privileges:true'],
                       'Tmpfs': {'/tmp': 'rw,noexec,nosuid,size=16m'},
                       'RestartPolicy': {'Name': 'unless-stopped'},
                       'LogConfig': {'Type': 'json-file', 'Config': {'max-size': '10m', 'max-file': '3'}}}}
    if network_mode == 'bridge':
        container_config['NetworkingConfig'] = {'EndpointsConfig': endpoints}
    cid = api.docker('/containers/create?name=' + NAME, 'POST', container_config)['Id']
    api.docker('/containers/' + cid + '/start', 'POST')
    time.sleep(2)
    status = api.docker('/containers/' + cid + '/json')['State']
    print(json.dumps({'container': NAME, 'running': status['Running'],
                      'stack_id': stack['Id'], 'poll_seconds': config['poll_seconds']}))
    if not status['Running']:
        raise RuntimeError('Updater did not remain running; inspect sanitized container logs')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--portainer-url', required=True)
    parser.add_argument('--portainer-container', default='portainer')
    parser.add_argument('--config', type=pathlib.Path, required=True)
    parser.add_argument('--key-file', type=pathlib.Path, required=True)
    parser.add_argument('--runtime-image', required=True)
    parser.add_argument('--health-ca', type=pathlib.Path)
    parser.add_argument('--replace', action='store_true')
    install(parser.parse_args())
