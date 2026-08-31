function readPackage(pkg, context) {
  if (pkg.name === 'esbuild') {
    pkg.scripts = pkg.scripts || {};
    delete pkg.scripts.postinstall;
  }
  return pkg;
}

module.exports = {
  hooks: {
    readPackage,
  },
};
