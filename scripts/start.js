'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const dialect = String(process.env.DB_DIALECT || 'postgres').toLowerCase();

function runServer() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    stdio: 'inherit',
    env: process.env
  });
  child.on('exit', code => { process.exitCode = code ?? 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => child.kill(signal));
  }
}

if (dialect === 'mariadb' || dialect === 'mysql') {
  // MariaDB schema setup is a separate, guarded, manual operation.
  // Never run the PostgreSQL migration runner against a MariaDB connection.
  runServer();
} else if (dialect === 'postgres' || dialect === 'postgresql') {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'migrate.js')], {
    stdio: 'inherit',
    env: process.env
  });
  child.on('exit', code => {
    if (code !== 0) {
      process.exitCode = code ?? 1;
      return;
    }
    runServer();
  });
} else {
  throw new Error('DB_DIALECT non supportato. Valori ammessi: postgres, mariadb.');
}
