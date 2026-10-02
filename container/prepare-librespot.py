"""Keep device-authorization announcements out of the PCM stdout stream."""
from pathlib import Path
import sys

source = Path(sys.argv[1]) / 'oauth/src/lib.rs'
text = source.read_text()
for original in ['        println!("Browse to: {url}");', '        println!("If prompted, enter code: {}", auth.user_code());']:
    if text.count(original) != 1:
        raise SystemExit('Unexpected device-authorization source; refusing to patch.')
    text = text.replace(original, original.replace('println!', 'eprintln!', 1))
source.write_text(text)
