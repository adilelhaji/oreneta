#!/usr/bin/env bash
# Starts a throwaway Prosody XMPP server on 127.0.0.1 for the chat tests
# (#111): domain `chat.test`, users `ana` and `pau` (password `secret`),
# message archive (MAM), carbons, group chat at `rooms.chat.test` with its
# own archive (ADR-0044), and HTTP File Upload at `upload.chat.test`.
# Plain XMPP on loopback only, so the tests can see what the server does
# without a certificate; the rule that a password never goes in clear is
# tested in the client. Files go over HTTPS on PORT+221 (15443 by default)
# with a certificate for 127.0.0.1 from a throwaway authority made here
# (certs/ca.pem), which only the test trusts.
#
#   sudo bash tests/prosody-xmpp.sh /tmp/oreneta-xmpp 15222
#   ORENETA_PROSODY=127.0.0.1:15222 ORENETA_PROSODY_CA=/tmp/oreneta-xmpp/certs/ca.pem cargo test chat::
set -eu
DIR=$1
PORT=${2:-15222}
HTTPS_PORT=$((PORT + 221))
if [ -f "$DIR/prosody.pid" ]; then
  # Only the instance this script started before, by its own pid file.
  kill "$(cat "$DIR/prosody.pid")" 2>/dev/null || true
  sleep 0.5
fi
rm -rf "$DIR"
mkdir -p "$DIR/data" "$DIR/certs"
C="$DIR/certs"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 2 \
  -subj "/CN=Oreneta test authority" -keyout "$C/ca.key" -out "$C/ca.pem" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -subj "/CN=127.0.0.1" -keyout "$C/upload.key" -out "$C/upload.csr" 2>/dev/null
printf 'subjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature\n' > "$C/upload.ext"
openssl x509 -req -in "$C/upload.csr" -CA "$C/ca.pem" -CAkey "$C/ca.key" -CAcreateserial -days 2 \
  -extfile "$C/upload.ext" -out "$C/upload.pem" 2>/dev/null
DEBUG_LOG=""
if [ -n "${ORENETA_PROSODY_DEBUG:-}" ]; then DEBUG_LOG="debug = \"$DIR/prosody.debug.log\"; "; fi
cat > "$DIR/prosody.cfg.lua" <<CONF
pidfile = "$DIR/prosody.pid"
data_path = "$DIR/data"
log = { ${DEBUG_LOG}info = "$DIR/prosody.log"; error = "$DIR/prosody.err" }
daemonize = true
interfaces = { "127.0.0.1" }
c2s_ports = { $PORT }
s2s_ports = { }
c2s_require_encryption = false
allow_unencrypted_plain_auth = true
authentication = "internal_plain"
storage = "internal"
archive_expires_after = "never"
default_archive_policy = true
modules_enabled = { "roster"; "saslauth"; "disco"; "carbons"; "mam"; "ping"; "presence"; "message"; "iq"; "offline"; "smacks" }
modules_disabled = { "s2s"; "tls" }
http_ports = { }
https_ports = { $HTTPS_PORT }
https_interfaces = { "127.0.0.1" }
https_ssl = { certificate = "$C/upload.pem"; key = "$C/upload.key" }
http_default_host = "upload.chat.test"
VirtualHost "chat.test"
  disco_items = { { "upload.chat.test", "file upload" } }
Component "rooms.chat.test" "muc"
  modules_enabled = { "muc_mam" }
  muc_room_default_history_length = 50
Component "upload.chat.test" "http_file_share"
  http_external_url = "https://127.0.0.1:$HTTPS_PORT/"
  http_file_share_size_limit = 1048576
  http_file_share_access = { "chat.test" }
CONF
chmod -R 0777 "$DIR"
for user in ana pau; do
  runuser -u prosody -- prosodyctl --config "$DIR/prosody.cfg.lua" register "$user" chat.test secret
done
# Prosody refuses to run as root; it runs as its package's own user.
runuser -u prosody -- prosody --config "$DIR/prosody.cfg.lua"
for _ in $(seq 1 20); do
  if (exec 3<>/dev/tcp/127.0.0.1/$PORT) 2>/dev/null && (exec 3<>/dev/tcp/127.0.0.1/$HTTPS_PORT) 2>/dev/null; then exit 0; fi
  sleep 0.3
done
cat "$DIR/prosody.err" "$DIR/prosody.log" >&2 || true
exit 1
