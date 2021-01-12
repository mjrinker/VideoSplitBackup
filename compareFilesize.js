const fs = require('fs');
const path = require('path');

const files = {};

const traverseDirectory = (directory) => {
	fs.readdirSync(directory).forEach((name) => {
		const filepath = path.join(directory, name);
		const item = fs.lstatSync(filepath);
		if (item.isFile()) {
			let genericFilepath = filepath.replace(/^D:/, '');
			const size = fs.statSync(filepath).size;
			const isSplit = directory.match(/\.split$/, '');
			if (isSplit) {
				genericFilepath = directory.replace(/^D:/, '').replace(/\.split$/, '');
			}
			if (files[genericFilepath]) {
				files[genericFilepath].size += size;
			} else {
				let originalFilepath = "";
				if (isSplit) {
					originalFilepath = directory.replace(/^D:/, 'P:').replace(/\.split$/, '');
				} else {
					originalFilepath = filepath.replace(/^D:/, 'P:');
				}

				let originalSize = null;
				if (fs.existsSync(originalFilepath)) {
					originalSize = fs.statSync(originalFilepath).size;
				}

				files[genericFilepath] = {
					filepath,
					originalFilepath,
					genericFilepath,
					size,
					originalSize
				};
			}
		} else if (item.isDirectory()) {
			traverseDirectory(filepath);
		}
	});
}

traverseDirectory('D:\\Media');
fs.writeFileSync('D:\\Media\\sizes.log', 'Filepath\tOriginal Size\tBackup Size\tSize Difference\n');
Object.values(files).forEach((file) => {
	fs.writeFileSync('D:\\Media\\sizes.log', `${[file.genericFilepath, file.originalSize, file.size, file.originalSize - file.size].join('\t')}\n`, { flag: 'a+' });
});
