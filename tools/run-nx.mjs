const [major, minor] = process.versions.node.split('.').map(Number);

if (major !== 24 || minor < 15) {
  console.error(
    `Node 24.15 or newer is required; received ${process.version}. Use the repository's .nvmrc or .node-version.`,
  );
  process.exit(1);
}

await import('../node_modules/nx/dist/bin/nx.js');
