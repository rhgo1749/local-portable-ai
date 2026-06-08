const path = require('path');
const projectRoot = path.resolve(__dirname, '..');

let kordoc = null;
async function getKordoc() {
    if (!kordoc) {
        const kordocPath = 'file:///' + path.resolve(projectRoot, 'node_modules', 'kordoc', 'dist', 'index.js').replace(/\\/g, '/');
        kordoc = await import(kordocPath);
    }
    return kordoc;
}

module.exports = {
    getKordoc
};
