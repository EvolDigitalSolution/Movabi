#!/usr/bin/env bash
# Read-only: inspect compose references, never environment values or secret-file contents.
set -eu
python3 - <<'PY'
import json,re,subprocess
from pathlib import Path
def run(args):
 p=subprocess.run(args,text=True,capture_output=True,timeout=30)
 return p.returncode,p.stdout.strip()
d=['docker']
if run(d+['info','--format','{{.ServerVersion}}'])[0]:d=['sudo','-n','docker']
code,project=run(d+['inspect','--format','{{index .Config.Labels "com.docker.compose.project"}}','movabi-develop-api'])
if code or project!='movabi-develop':raise SystemExit('Verified develop API compose identity required')
code,refs=run(d+['inspect','--format','{{index .Config.Labels "com.docker.compose.project.config_files"}}','movabi-develop-api'])
if code or not refs:raise SystemExit('Compose file reference unavailable')
for reference in refs.split(','):
 p=Path(reference)
 if not p.is_absolute() or '..' in p.parts or p.suffix not in ('.yml','.yaml'):
  print(json.dumps({'referenceUnavailable':True}));continue
 try:source=p.read_text()
 except Exception:print(json.dumps({'composeReference':str(p),'readable':False}));continue
 bindings=sorted(set(re.findall(r'\$\{([A-Z][A-Z0-9_]*)',source)))
 mechanisms=[name for name,pattern in [('1password',r'\bop run\b'),('vault',r'\bvault (?:agent|exec)\b'),('doppler',r'\bdoppler run\b'),('infisical',r'\binfisical run\b')] if re.search(pattern,source)]
 env_refs=[];section_indent=None
 for line in source.splitlines():
  match=re.match(r'^(\s*)env_file:\s*(.*?)\s*$',line)
  candidate=None
  if match:
   section_indent=len(match[1]);candidate=match[2].strip("\"'")
  elif section_indent is not None:
   indent=len(line)-len(line.lstrip())
   if line.strip() and indent<=section_indent:section_indent=None
   elif line.lstrip().startswith('- '):candidate=line.strip()[2:].strip("\"'")
  if candidate and re.fullmatch(r'[A-Za-z0-9_./-]+',candidate):env_refs.append(candidate)
 print(json.dumps({'composeReference':str(p),'bindingNames':bindings,'envFileReferencesOnly':sorted(set(env_refs)),'managerCommandMarkers':mechanisms,'dockerSecretsSectionPresent':bool(re.search(r'^secrets:\s*$',source,re.M))}))
print('No container environment or secret files read. An env_file reference alone is not proof of a secret manager.')
PY
