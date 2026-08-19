const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const pkgPath = path.join(__dirname, 'package.json');
const pkgData = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

// Auto-increment patch version (e.g. 1.0.0 -> 1.0.1)
const versionParts = (pkgData.version || '1.0.0').split('.').map(Number);
if (versionParts.length === 3) {
  versionParts[2] += 1;
} else {
  versionParts.push(1);
}
pkgData.version = versionParts.join('.');

// Save updated package.json
fs.writeFileSync(pkgPath, JSON.stringify(pkgData, null, 2) + '\n', 'utf8');

console.log('\n======================================================');
console.log(`📦 Auto-Incrementing Version to: v${pkgData.version}`);
console.log('🔨 Starting PKG Build for GlobalPanelHealth.exe...');
console.log('======================================================\n');

try {
  // Execute pkg build
  execSync('npx pkg . --target node18-win-x64 --output GlobalPanelHealth.exe', {
    stdio: 'inherit'
  });
  console.log(`\n🎉 BUILD SUCCESS! GlobalPanelHealth.exe is ready with Version: v${pkgData.version}\n`);
} catch (error) {
  console.error('\n❌ BUILD FAILED:', error.message);
  process.exit(1);
}
