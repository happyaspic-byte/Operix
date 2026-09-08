"""Exercise the deployed backup shell at the PostgreSQL command boundary."""

import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest


TEMPLATE = Path(__file__).resolve().parents[1] / "deploy/nas/compose.template.json"
FAKE_POSTGRES = r'''
import os
from pathlib import Path
import sys

command = Path(sys.argv[0]).name
with open(os.environ["TEST_BACKUP_LOG"], "a") as log:
    log.write(command + "\n")
if command == "pg_dump":
    output = next(arg.split("=", 1)[1] for arg in sys.argv[1:] if arg.startswith("--file="))
    Path(output).write_bytes(os.environ.get("TEST_DUMP_CONTENT", "PGDMP-original").encode())
    sys.exit(int(os.environ.get("TEST_DUMP_EXIT", "0")))
if os.environ.get("TEST_RESTORE_EXIT"):
    sys.exit(int(os.environ["TEST_RESTORE_EXIT"]))
sys.exit(0 if Path(sys.argv[-1]).read_bytes().startswith(b"PGDMP") else 9)
'''


class BackupTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.template = json.loads(TEMPLATE.read_text())

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="operix-backup-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.backups = self.root / "backups"
        self.backups.mkdir(mode=0o755)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.log = self.root / "commands.log"
        for name in ("pg_dump", "pg_restore"):
            executable = self.bin / name
            executable.write_text("#!" + sys.executable + "\n" + FAKE_POSTGRES)
            executable.chmod(0o700)
        self.script = self.template["services"]["backup"]["command"][0]
        self.script = self.script.replace("/backups", str(self.backups)).replace("$$", "$")

    def run_backup(self, deployment="deploy_123-1", **variables):
        environment = {
            "PATH": str(self.bin) + os.pathsep + os.defpath,
            "DEPLOYMENT_ID": deployment,
            "TEST_BACKUP_LOG": str(self.log),
            **variables,
        }
        return subprocess.run(
            ["/bin/sh", "-ec", self.script], cwd=self.root, env=environment,
            capture_output=True, text=True, timeout=10,
        )

    def commands(self):
        return self.log.read_text().splitlines() if self.log.exists() else []

    def test_invalid_deployment_ids_do_not_run_postgres_or_write_files(self):
        for deployment in ("", "../escape", "a/b", "a b", "a\nb", "$(touch escaped)", "a" * 129):
            with self.subTest(deployment=deployment):
                result = self.run_backup(deployment)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.commands(), [])
                self.assertEqual(list(self.backups.iterdir()), [])
        self.assertFalse((self.root / "escaped").exists())
        self.assertFalse((self.root / "escape.dump").exists())

    def test_dump_failure_removes_partial_archive_and_does_not_publish(self):
        result = self.run_backup(TEST_DUMP_EXIT="17")
        self.assertEqual(result.returncode, 17)
        self.assertEqual(self.commands(), ["pg_dump"])
        self.assertEqual(list(self.backups.iterdir()), [])

    def test_restore_validation_failure_does_not_publish_partial_archive(self):
        result = self.run_backup(TEST_RESTORE_EXIT="19")
        self.assertEqual(result.returncode, 19)
        self.assertEqual(self.commands(), ["pg_dump", "pg_restore"])
        self.assertEqual(list(self.backups.iterdir()), [])

    def test_success_is_private_and_same_deployment_retry_preserves_first_dump(self):
        result = self.run_backup()
        self.assertEqual(result.returncode, 0, result.stderr)
        archive = self.backups / "deploy_123-1.dump"
        self.assertEqual(archive.read_bytes(), b"PGDMP-original")
        self.assertEqual(stat.S_IMODE(archive.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.backups.stat().st_mode), 0o700)
        self.assertEqual(list(self.backups.iterdir()), [archive])
        os.utime(archive, (1000, 1000))
        result = self.run_backup(TEST_DUMP_EXIT="17", TEST_DUMP_CONTENT="PGDMP-replacement")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(archive.read_bytes(), b"PGDMP-original")
        self.assertEqual(archive.stat().st_mtime, 1000)
        self.assertEqual(self.commands(), ["pg_dump", "pg_restore", "pg_restore"])

    def test_corrupt_existing_backup_is_rejected_without_overwriting_it(self):
        archive = self.backups / "deploy_123-1.dump"
        archive.write_bytes(b"corrupt")
        result = self.run_backup()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(archive.read_bytes(), b"corrupt")
        self.assertEqual(self.commands(), ["pg_restore"])

    def test_retention_keeps_seven_newest_dumps_and_preserves_other_files(self):
        for number in range(10):
            archive = self.backups / f"deploy_{number}.dump"
            archive.write_bytes(b"PGDMP-previous")
            os.utime(archive, (1000 + number, 1000 + number))
        protected = [self.backups / name for name in
                     ("notes.txt", "manual.dump.sha256", "interrupted.dump.part", ".hidden.dump")]
        protected.append(self.root / "outside.dump")
        for path in protected:
            path.write_bytes(b"preserve")
        directory = self.backups / "unrelated"
        directory.mkdir()
        result = self.run_backup("deploy_new")
        self.assertEqual(result.returncode, 0, result.stderr)
        dumps = {path.name for path in self.backups.iterdir()
                 if path.name.endswith(".dump") and not path.name.startswith(".")}
        self.assertEqual(dumps, {f"deploy_{number}.dump" for number in range(4, 10)} | {"deploy_new.dump"})
        for path in protected:
            self.assertEqual(path.read_bytes(), b"preserve")
        self.assertTrue(directory.is_dir())

    def test_backup_migration_and_readiness_dependencies_gate_startup(self):
        services = self.template["services"]
        for service, dependency, condition in (
            ("backup", "db", "service_healthy"),
            ("migrate", "backup", "service_completed_successfully"),
            ("web", "migrate", "service_completed_successfully"),
            ("worker", "migrate", "service_completed_successfully"),
            ("deployment-check", "web", "service_healthy"),
            ("deployment-check", "worker", "service_started"),
        ):
            with self.subTest(service=service, dependency=dependency):
                self.assertEqual(services[service]["depends_on"][dependency]["condition"], condition)
        self.assertEqual(services["backup"]["image"], services["db"]["image"])
        self.assertTrue(self.template["volumes"]["backups"]["external"])


if __name__ == "__main__":
    unittest.main()
