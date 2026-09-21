"""Exercise host backup scripts through fake external commands, never production."""
import fcntl
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
FAKE = r'''
import os,sys,time
from pathlib import Path
name=Path(sys.argv[0]).name
args=sys.argv[1:]
with open(os.environ['COMMAND_LOG'],'a') as log: log.write(name+' '+' '.join(args)+'\n')
if name=='docker':
    if 'ps' in args: print(os.environ.get('RUNNING_SERVICES','web\nworker'))
    if 'manifest' in args:
        if os.environ.get('FAIL_MANIFEST'): sys.exit(17)
        print('{}')
    if 'tombstones' in args: print('[]')
    if 'pg_dump' in args: print('PGDMP-synthetic')
    if 'backup-start' in args and os.environ.get('FAIL_START'): sys.exit(18)
if name=='age':
    Path(args[args.index('-o')+1]).write_bytes(sys.stdin.buffer.read())
if name=='rsync': sys.exit(int(os.environ.get('RSYNC_EXIT','0')))
'''
class FullBackupTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory(prefix='operix-full-backup-'); self.addCleanup(temp.cleanup)
        self.root=Path(temp.name); (self.root/'scripts').mkdir(); (self.root/'bin').mkdir()
        for name in ['backup.sh','scheduled-backup.sh','recovery-lock.sh']:
            source=ROOT/'scripts'/name
            if source.exists(): (self.root/'scripts'/name).write_text(source.read_text())
        (self.root/'.env').write_text('SYNTHETIC=1\n')
        self.log=self.root/'commands.log'
        for name in ['docker','age','rsync']:
            p=self.root/'bin'/name;p.write_text('#!'+sys.executable+'\n'+FAKE);p.chmod(0o700)
        subprocess.run(['git','init','-q'],cwd=self.root,check=True)
        subprocess.run(['git','-c','user.name=Test','-c','user.email=test@operix.test','commit','--allow-empty','-qm','Synthetic'],cwd=self.root,check=True)
        self.env={**os.environ,'PATH':str(self.root/'bin')+os.pathsep+os.defpath,'COMMAND_LOG':str(self.log),
          'BACKUP_ROOT':str(self.root/'backups'),'BACKUP_AGE_RECIPIENT':'synthetic','BACKUP_REMOTE':'synthetic-host:/backups'}
    def run_script(self,name='backup.sh',**variables):
        return subprocess.run(['bash','scripts/'+name,str(self.root/'backups')],cwd=self.root,env={**self.env,**variables},capture_output=True,text=True,timeout=15)
    def commands(self): return self.log.read_text() if self.log.exists() else ''
    def test_overlapping_recovery_is_rejected_without_stopping_or_starting_writers(self):
        # Hold the same host lock as an in-progress backup or restore.
        with open(self.root/'.operix-recovery.lock','w') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            result=self.run_script()
        self.assertNotEqual(result.returncode,0)
        self.assertEqual(self.commands(),'')
    def test_start_failure_does_not_restart_previously_stopped_services(self):
        result=self.run_script(FAIL_START='1',RUNNING_SERVICES='')
        self.assertNotEqual(result.returncode,0)
        self.assertNotIn('compose start',self.commands())
    def test_backup_failure_resumes_only_previously_running_services(self):
        result=self.run_script(FAIL_MANIFEST='1',RUNNING_SERVICES='web')
        self.assertNotEqual(result.returncode,0)
        self.assertIn('compose start web\n',self.commands())
        self.assertNotIn('compose start web worker',self.commands())
        self.assertNotIn('backup-complete',self.commands())
    def test_transfer_failure_never_marks_remote_copy_successful(self):
        result=self.run_script('scheduled-backup.sh',RSYNC_EXIT='23')
        self.assertEqual(result.returncode,23,result.stderr)
        self.assertIn('backup-complete',self.commands())
        self.assertNotIn('backup-replicated',self.commands())
    def test_success_records_remote_copy_only_after_transfer(self):
        result=self.run_script('scheduled-backup.sh')
        self.assertEqual(result.returncode,0,result.stderr)
        log=self.commands()
        self.assertLess(log.index('rsync '),log.index('backup-replicated'))
        self.assertEqual(log.count('backup-replicated'),1)
if __name__=='__main__':unittest.main()
