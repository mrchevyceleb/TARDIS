"""Import only an explicitly supplied private office connection into TARDIS."""
import json
from pathlib import Path
from urllib.parse import urlsplit

KEYS = ('TARDIS_OFFICE_MCP_URL', 'TARDIS_OFFICE_MCP_TOKEN', 'TARDIS_OFFICE_ADMIN_TOKEN')

def read_office_config(path):
    source = json.loads(Path(path).read_text(encoding='utf-8-sig'))
    values = {key: source[key] for key in KEYS}
    if not all(isinstance(v, str) and v.strip() == v and v for v in values.values()):
        raise ValueError('Office configuration is incomplete')
    url = urlsplit(values[KEYS[0]])
    if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in ('', '/', '/mcp', '/mcp/'):
        raise ValueError('Office URL must be an HTTPS service root or /mcp endpoint')
    values[KEYS[0]] = f'https://{url.netloc}'
    if min(len(values[KEYS[1]]), len(values[KEYS[2]])) < 32 or values[KEYS[1]] == values[KEYS[2]]:
        raise ValueError('Office connection needs distinct strong agent and admin tokens')
    return values

def install(source, destination):
    values = read_office_config(source)
    path = Path(destination)
    current = {k: json.loads(v) for line in path.read_text().splitlines() if line and not line.startswith('#') for k,v in [line.split('=',1)]} if path.exists() else {}
    # Reruns preserve an existing connection; partial configs are not safe to mix.
    existing = {key: current[key] for key in KEYS if key in current}
    if existing and existing != values:
        raise ValueError('Existing office connection differs. Review it before replacing it.')
    current.update(values)
    temp = path.with_suffix('.office.tmp')
    temp.write_text(''.join(k+'='+json.dumps(v)+'\n' for k,v in current.items()), encoding='utf-8')
    temp.chmod(0o600); temp.replace(path)

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source'); parser.add_argument('destination')
    args = parser.parse_args()
    install(args.source, args.destination)
