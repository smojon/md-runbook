// Makes the app's client key with the SSH library itself (as the real app will), writes the
// private key as PKCS#8 to argv[2], and appends the public key to the authorized_keys file
// argv[3]. Also reports whether the library can import the ssh-keygen key in argv[4] (diagnostic).
const fs = require('fs');
const ssh = require('@microsoft/dev-tunnels-ssh');
const keys = require('@microsoft/dev-tunnels-ssh-keys');

(async () => {
  const [privFile, authorizedKeys, keygenKey] = process.argv.slice(2);
  const pair = await ssh.SshAlgorithms.publicKey.ecdsaSha2Nistp256.generateKeyPair();
  fs.writeFileSync(privFile, await keys.exportPrivateKey(pair, null, 5 /* KeyFormat.Pkcs8 */), { mode: 0o600 });
  fs.appendFileSync(authorizedKeys, (await keys.exportPublicKey(pair)) + '\n');
  console.log('app key made with the library (PKCS#8, ecdsa-sha2-nistp256)');
  if (keygenKey) {
    const text = fs.readFileSync(keygenKey, 'utf8');
    try {
      await keys.importKey(text);
      console.log(`diagnostic: the library imports the ssh-keygen key (${text.split('\n')[0]})`);
    } catch (e) {
      console.log(`diagnostic: the library can NOT import the ssh-keygen key (${text.split('\n')[0]}): ${e.message}`);
    }
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
