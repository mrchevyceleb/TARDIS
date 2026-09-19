#!/usr/bin/env python3
"""Expose the installed TARDIS runtime in new Bash terminals, without restarting services."""
from pathlib import Path
import shlex
import shutil
import sys

home = Path.home()
node_dir = Path(sys.argv[1]).resolve()
if sys.platform != 'linux' or not (node_dir / 'bin/node').is_file():
    raise SystemExit('Provide the installed Linux Node runtime directory.')
config = home / '.config/tardis'
bin_dir = home / '.local/bin'
config.mkdir(parents=True, exist_ok=True)
bin_dir.mkdir(parents=True, exist_ok=True)
launcher = bin_dir / 'grok'
marker = '# TARDIS Grok browser launcher'
if launcher.exists() and marker not in launcher.read_text():
    raise SystemExit('An existing grok command is present; leaving it unchanged.')
paths = [bin_dir, node_dir / 'bin', home / '.local/share/tardis-runtime/npm/bin']
settings = config / 'terminal.sh'
settings.write_text('''# TARDIS command paths for interactive terminals.
for tardis_bin in ''' + ' '.join(shlex.quote(str(path)) for path in paths) + '''; do
  case ":$PATH:" in *":$tardis_bin:"*) ;; *) PATH="$tardis_bin:$PATH" ;; esac
done
export PATH
unset tardis_bin
''')
settings.chmod(0o600)
hook = '[ ! -r "$HOME/.config/tardis/terminal.sh" ] || . "$HOME/.config/tardis/terminal.sh"'
for name in ['.bashrc', '.profile']:
    profile = home / name
    contents = profile.read_text() if profile.exists() else ''
    if hook in contents:
        continue
    backup = home / (name + '.before-tardis-terminal')
    if profile.exists() and not backup.exists():
        shutil.copy2(profile, backup)
    with profile.open('a') as stream:
        stream.write('\n# TARDIS terminal commands\n' + hook + '\n')
launcher.write_text('''#!/usr/bin/env bash
# TARDIS Grok browser launcher
case "${*:-}" in
  ''|login|'auth login')
    printf 'Grok uses the TARDIS browser connection on this computer. Opening it now.\n'
    exec xdg-open http://127.0.0.1:8091/xai-oauth ;;
  -h|--help|help)
    printf 'TARDIS Grok browser launcher\nUsage: grok [login]\nOpens the existing Grok subscription connection in TARDIS; this is not a standalone Grok CLI.\n' ;;
  *) printf 'Use grok login to open the TARDIS connection, or grok --help.\n' >&2; exit 2 ;;
esac
''')
launcher.chmod(0o700)
print('Terminal commands configured. Open a new terminal to use codex, claude, and the Grok browser launcher.')
