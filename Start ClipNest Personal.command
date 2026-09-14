#!/bin/zsh
# Personal source edition. Does not alter dist/ClipNest.app or release ZIPs.
cd -- "${0:A:h}" || exit 1
if [[ -x /opt/homebrew/bin/python3.11 ]]; then
  exec /opt/homebrew/bin/python3.11 app.py --open-browser
elif [[ -x /usr/local/bin/python3.11 ]]; then
  exec /usr/local/bin/python3.11 app.py --open-browser
else
  exec python3.11 app.py --open-browser
fi
