// Prints the developer Key Vault secrets for a local start as one JSON object on stdout.
// The caller keeps that stdout; a failure is one line on stderr and a non-zero exit, with no secret in it.
import { assertAzureSignedIn, DevSecretsError, loadDeveloperSecrets } from '../src/dev-secrets.ts';

const target = process.argv[2];
if (target === 'signin') {
  try {
    await assertAzureSignedIn();
  } catch (err) {
    console.error(err instanceof DevSecretsError ? err.message : 'Could not load developer secrets from Azure.');
    process.exit(1);
  }
  process.exit(0);
}
if (target !== 'server' && target !== 'client') {
  console.error('usage: node scripts/load-dev-secrets.ts <server|client|signin>');
  process.exit(1);
}

try {
  process.stdout.write(JSON.stringify(await loadDeveloperSecrets({ target })));
} catch (err) {
  console.error(err instanceof DevSecretsError ? err.message : 'Could not load developer secrets from Azure.');
  process.exit(1);
}
