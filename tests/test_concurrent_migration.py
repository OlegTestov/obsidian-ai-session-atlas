"""Both migrators see an old schema before either acquires SQLite's writer lock."""
from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
from pathlib import Path

from atlas import db


def test_waiting_migrator_does_not_backfill_again(tmp_path):
    path = tmp_path / "catalog.sqlite3"
    conn = db.connect(str(path))
    conn.execute("INSERT INTO fts(session_id,turn,user_text) VALUES ('a',1,'preserved')")
    conn.execute("DROP TABLE fts_rows")
    conn.execute("UPDATE meta SET value='12' WHERE key='schema_version'")
    conn.commit()
    conn.close()
    worker = '''
import sqlite3,sys,time
from pathlib import Path
from atlas import db
root=Path(sys.argv[1]); who=sys.argv[2]
original=sqlite3.connect
class Controlled(sqlite3.Connection):
 def gate(self,sql):
  if sql.startswith('BEGIN IMMEDIATE'):
   (root/('ready-'+who)).touch()
   end=time.monotonic()+10
   while not all((root/('ready-'+i)).exists() for i in ('1','2')):
    assert time.monotonic()<end
    time.sleep(.01)
   if who=='2':
    while not (root/'finished-1').exists():
     assert time.monotonic()<end
     time.sleep(.01)
 def executescript(self,sql):
  self.gate(sql)
  return super().executescript(sql)
 def execute(self,sql,*args):
  self.gate(sql)
  return super().execute(sql,*args)
def connect(*args,**kwargs):
 kwargs['factory']=Controlled
 c=original(*args,**kwargs)
 c.set_trace_callback(lambda sql: (root/('trace-'+who)).open('a').write(sql+'\\n'))
 return c
db.sqlite3.connect=connect
c=db.connect(str(root/'catalog.sqlite3')); c.close()
(root/('finished-'+who)).touch()
'''
    env = dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parents[1]))
    processes = [subprocess.Popen([sys.executable, "-c", worker, str(tmp_path), who],
                                 env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                 for who in ("1", "2")]
    try:
        for process in processes:
            out, err = process.communicate(timeout=20)
            assert process.returncode == 0, out + err
    finally:
        for process in processes:
            if process.poll() is None:
                process.kill()
                process.wait()
    counts = [sum("INSERT OR REPLACE INTO fts_rows" in line and "SELECT" in line
                  for line in (tmp_path / ("trace-" + who)).read_text().splitlines())
              for who in ("1", "2")]
    assert counts == [2, 0]
    conn = sqlite3.connect(path)
    assert conn.execute("SELECT user_text FROM fts").fetchone()[0] == "preserved"
    assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    conn.close()
