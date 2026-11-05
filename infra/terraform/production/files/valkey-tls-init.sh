set -eu
# Init container (the pinned Valkey image, which ships openssl). Each replica gets its own CA and a server
# certificate for 127.0.0.1 in the shared EmptyDir at /tls. The CA key is deleted once it has signed, and
# the server key is readable only by the valkey user. Nothing leaves the replica.
umask 077
cat > /tmp/ca.cnf <<'CNF'
[req]
distinguished_name = dn
x509_extensions = v3_ca
prompt = no
[dn]
CN = townwise-valkey-ca
[v3_ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
CNF
printf 'basicConstraints = critical,CA:FALSE\nkeyUsage = critical,digitalSignature\nextendedKeyUsage = serverAuth\nsubjectAltName = IP:127.0.0.1\n' > /tmp/server.ext
openssl req -x509 -new -config /tmp/ca.cnf -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -days 3650 -keyout /tmp/ca.key -out /tls/ca.crt 2> /dev/null
openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -subj /CN=127.0.0.1 \
  -keyout /tls/server.key -out /tmp/server.csr 2> /dev/null
openssl x509 -req -in /tmp/server.csr -CA /tls/ca.crt -CAkey /tmp/ca.key -set_serial "0x$(openssl rand -hex 16)" \
  -days 3650 -extfile /tmp/server.ext -out /tls/server.crt 2> /dev/null
rm -f /tmp/ca.key /tmp/server.csr /tmp/server.ext /tmp/ca.cnf
chown valkey /tls/server.key /tls/server.crt
chmod 0400 /tls/server.key
chmod 0444 /tls/server.crt /tls/ca.crt
echo "valkey tls ready"
