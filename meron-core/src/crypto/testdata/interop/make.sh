#!/usr/bin/env bash
# Makes the interoperability fixtures for #49 with GnuPG and OpenSSL, not with
# this codebase. Run once; the outputs are committed with README.md, which
# records the tool versions they were made with. Test material only.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export GNUPGHOME="$work/gnupg"
mkdir -m 700 "$GNUPGHOME"
cd "$work"

# ---- OpenPGP ----------------------------------------------------------------
cat > pau.batch <<'K'
%no-protection
Key-Type: EDDSA
Key-Curve: ed25519
Subkey-Type: ECDH
Subkey-Curve: cv25519
Name-Real: Pau Interop
Name-Email: pau@example.test
Expire-Date: 0
%commit
K
gpg --batch --quiet --gen-key pau.batch
gpg --batch --armor --export pau@example.test > "$here/pau_public.asc"
gpg --batch --armor --export-secret-keys pau@example.test > "$here/pau_secret.asc"

# A key that expired in 2021, made and used while it was valid.
cat > olga.batch <<'K'
%no-protection
Key-Type: EDDSA
Key-Curve: ed25519
Name-Real: Olga Expired
Name-Email: olga@example.test
Expire-Date: 2021-01-01
%commit
K
gpg --batch --quiet --faked-system-time 20200101T000000 --gen-key olga.batch
gpg --batch --armor --export olga@example.test > "$here/olga_public.asc"

# The #12 fixture key receives the encrypted message.
gpg --batch --quiet --import "$here/../gnupg/fixture_secret.asc"

part=$'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\nHello from GnuPG.\r\n'
printf '%s' "$part" > part.txt

pgp_signed() { # signer, from, file, [faked time]
  local extra=()
  [ -n "${4:-}" ] && extra=(--faked-system-time "$4")
  rm -f sig.asc
  gpg --batch --quiet "${extra[@]}" --local-user "$1" --digest-algo SHA256 --armor --detach-sign -o sig.asc part.txt
  {
    printf 'From: %s\r\nTo: fixture@example.test\r\nSubject: Signed with GnuPG\r\nMIME-Version: 1.0\r\n' "$2"
    printf 'Content-Type: multipart/signed; boundary="b1"; micalg=pgp-sha256; protocol="application/pgp-signature"\r\n\r\n'
    printf -- '--b1\r\n%s\r\n--b1\r\nContent-Type: application/pgp-signature; name="signature.asc"\r\n\r\n' "$part"
    sed 's/$/\r/' sig.asc
    printf -- '\r\n--b1--\r\n'
  } > "$here/$3"
}
pgp_signed pau@example.test 'Pau Interop <pau@example.test>' pgp_signed.eml
sed 's/Hello from GnuPG\./Hello from GnuPG!/' "$here/pgp_signed.eml" > "$here/pgp_signed_tampered.eml"
pgp_signed olga@example.test 'Olga Expired <olga@example.test>' pgp_signed_by_expired_key.eml 20200601T000000

gpg --batch --quiet --trust-model always --local-user pau@example.test --recipient fixture@example.test \
  --armor --sign --encrypt -o enc.asc part.txt
{
  printf 'From: Pau Interop <pau@example.test>\r\nTo: fixture@example.test\r\nSubject: Encrypted with GnuPG\r\nMIME-Version: 1.0\r\n'
  printf 'Content-Type: multipart/encrypted; boundary="b2"; protocol="application/pgp-encrypted"\r\n\r\n'
  printf -- '--b2\r\nContent-Type: application/pgp-encrypted\r\n\r\nVersion: 1\r\n\r\n--b2\r\nContent-Type: application/octet-stream\r\n\r\n'
  sed 's/$/\r/' enc.asc
  printf -- '\r\n--b2--\r\n'
} > "$here/pgp_encrypted_signed.eml"

# ---- S/MIME -----------------------------------------------------------------
cat > sara.cnf <<'C'
[req]
distinguished_name = dn
prompt = no
x509_extensions = ext
[dn]
CN = Sara Interop
emailAddress = sara@example.test
[ext]
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = emailProtection
subjectAltName = email:sara@example.test
C
openssl req -x509 -newkey rsa:2048 -nodes -keyout sara.key -out sara.pem -days 26000 -config sara.cnf 2>/dev/null
openssl x509 -in sara.pem -outform DER -out "$here/sara.der"
openssl pkcs12 -export -inkey sara.key -in sara.pem -name "Sara Interop" -passout pass:interop \
  -keypbe AES-256-CBC -certpbe AES-256-CBC -macalg sha256 -out "$here/sara.p12"
# The private key and PEM are kept only in the script's temporary directory.
cp sara.key sara_key.pem

printf 'From: Sara Interop <sara@example.test>\r\nTo: sara@example.test\r\nSubject: S/MIME with OpenSSL\r\n' > hdr.txt
printf '%s' "$part" > smime_part.txt

openssl smime -sign -in smime_part.txt -signer sara.pem -inkey sara.key -md sha256 -out signed.tmp
cat hdr.txt signed.tmp > "$here/smime_signed_detached.eml"

openssl smime -encrypt -aes256 -in smime_part.txt -out enc.tmp sara.pem
cat hdr.txt enc.tmp > "$here/smime_enveloped_aes256.eml"

openssl cms -encrypt -aes256 -in smime_part.txt -out oaep.tmp -recip sara.pem -keyopt rsa_padding_mode:oaep
cat hdr.txt oaep.tmp > "$here/smime_enveloped_oaep.eml"

openssl cms -encrypt -aes-256-gcm -in smime_part.txt -out gcm.tmp -recip sara.pem
cat hdr.txt gcm.tmp > "$here/smime_authenveloped_gcm.eml"

{
  echo "gpg: $(gpg --version | head -1)"
  echo "openssl: $(openssl version)"
} > "$here/VERSIONS"
