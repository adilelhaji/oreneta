#!/usr/bin/env bash
# Starts (as root, e.g. with sudo) a throwaway Dovecot POP3 server on 127.0.0.1 for the POP3 tests
# (#97): one user, `pau` / `secret`, mail in $1/home/pau/Maildir. Plain POP3
# on loopback only, so the tests can read what the server does without a
# certificate; the TLS rules are tested against the fake server.
#
#   sudo bash tests/dovecot-pop3.sh /tmp/pop3 11110
#   ORENETA_DOVECOT_POP3=127.0.0.1:11110 ORENETA_DOVECOT_DIR=/tmp/pop3 cargo test pop3::
set -eu
DIR=$1
PORT=${2:-11110}
rm -rf "$DIR"
# Unix sockets need a short path.
RUN=/tmp/oreneta-dovecot-$PORT
rm -rf "$RUN"
mkdir -p "$RUN" "$DIR/state" "$DIR/home/pau/Maildir/new" "$DIR/home/pau/Maildir/cur" "$DIR/home/pau/Maildir/tmp"
cat > "$DIR/dovecot.conf" <<CONF
base_dir = $RUN
state_dir = $DIR/state
log_path = $DIR/dovecot.log
protocols = pop3
listen = 127.0.0.1
ssl = no
disable_plaintext_auth = no
first_valid_uid = 100
auth_mechanisms = plain
mail_location = maildir:$DIR/home/%u/Maildir
pop3_uidl_format = %08Xu%08Xv
passdb {
  driver = static
  args = password=secret
}
userdb {
  driver = static
  args = uid=dovecot gid=dovecot home=$DIR/home/%u
}
service pop3-login {
  inet_listener pop3 {
    port = $PORT
  }
  inet_listener pop3s {
    port = 0
  }
}
service imap-login {
  inet_listener imap {
    port = 0
  }
}
CONF
# Mail is served as the package's own user; the tests drop messages in.
chmod -R 0777 "$DIR/home"
dovecot -c "$DIR/dovecot.conf"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if (exec 3<>/dev/tcp/127.0.0.1/$PORT) 2>/dev/null; then exit 0; fi
  sleep 0.3
done
cat "$DIR/dovecot.log" >&2
exit 1
