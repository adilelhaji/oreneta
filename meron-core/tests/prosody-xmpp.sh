#!/usr/bin/env bash
# Starts a throwaway Prosody XMPP server on 127.0.0.1 for the chat tests
# (#111): domain `chat.test`, users `ana` and `pau` (password `secret`),
# message archive (MAM), carbons and group chat at `rooms.chat.test`.
# Plain XMPP on loopback only, so the tests can see what the server does
# without a certificate; the rule that a password never goes in clear is
# tested in the client.
#
#   sudo bash tests/prosody-xmpp.sh /tmp/oreneta-xmpp 15222
#   ORENETA_PROSODY=127.0.0.1:15222 cargo test chat::
set -eu
DIR=$1
PORT=${2:-15222}
rm -rf "$DIR"
mkdir -p "$DIR/data" "$DIR/certs"
cat > "$DIR/prosody.cfg.lua" <<CONF
pidfile = "$DIR/prosody.pid"
data_path = "$DIR/data"
log = { info = "$DIR/prosody.log"; error = "$DIR/prosody.err" }
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
VirtualHost "chat.test"
Component "rooms.chat.test" "muc"
  modules_enabled = { "muc_mam" }
CONF
chmod -R 0777 "$DIR"
for user in ana pau; do
  runuser -u prosody -- prosodyctl --config "$DIR/prosody.cfg.lua" register "$user" chat.test secret
done
# Prosody refuses to run as root; it runs as its package's own user.
runuser -u prosody -- prosody --config "$DIR/prosody.cfg.lua"
for _ in $(seq 1 20); do
  if (exec 3<>/dev/tcp/127.0.0.1/$PORT) 2>/dev/null; then exit 0; fi
  sleep 0.3
done
cat "$DIR/prosody.err" "$DIR/prosody.log" >&2 || true
exit 1
