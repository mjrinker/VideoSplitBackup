const delay = require('delay');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const rimraf = require('rimraf');
const shell = require('shelljs');
const { v4: uuidv4 } = require('uuid');

const maxConcurrentVideos = 3;
const backupPath = 'D:\\Media';
const plexMediaPath = 'P:\\Media';
const restoreLogFilepath = path.join(plexMediaPath, 'restore.log');
const tempDir = path.join(backupPath, 'tmp');
const plexMediaDirectories = [
	'Audiobooks',
	'Courses',
	'Church Movies',
	'Home Videos',
	'Movies',
	'TV Shows',
];

let restored = [];
let currentVideos = [];
const videoQueue = [];

if (fs.existsSync(restoreLogFilepath)) {
	restored = String(fs.readFileSync(restoreLogFilepath)).split('\n');
}

if (!fs.existsSync(plexMediaPath)) {
	fs.mkdirSync(plexMediaPath);
}

process.on('unhandledRejection', (error) => {
	console.error(error);
	process.exit();
});

process.on('exit', () => {
	rimraf.sync(tempDir);
});

const logProgress = () => {
	const progress = currentVideos.map((video) => video.progress);
	process.stdout.write(`\rProcessing: ${progress.join('%    ')}%            `);
};

const timeStringToMilliseconds = (timeString) => {
	timeArray = timeString.split(':');
	hours = parseInt(timeArray.length > 0 ? timeArray[0] : '0');
	minutes = parseInt(timeArray.length > 1 ? timeArray[1] : '0');
	seconds = parseFloat(timeArray.length > 2 ? timeArray[2] : '0');
	return ((hours * 3600) + (minutes * 60) + seconds) * 1000;
};

const setListeners = (video, uuid) => {
	video
		.on('start', (command) => {
	    console.info(`\n${command}`);
	  }).on('progress', (progress) => {
	  	if (progress?.percent) {
		  	let progressPercent = progress.percent.toFixed(2);
		  	if (video.user?.outputDuration) {
		  		progressPercent = ((((timeStringToMilliseconds(progress.timemark) / video.user.outputDuration)) * 100) / (video._inputs.length || 0)).toFixed(2);
		  	}
		  	const videoObj = currentVideos.find((vid) => vid.uuid === uuid) || {};
		  	videoObj.progress = progressPercent;
		    logProgress();
		  }
	  })
	  // .on('stderr', (stderr) => {
	  //   console.error(stderr);
	  // })
	  .on('error', (err, stdout, stderr) => {
	    console.error('\nCannot process video: ' + err.message);
	  }).on('end', (stdout, stderr) => {
	    console.info('\nTranscoding succeeded!');
	  }).on('data', (chunk) => {
	  	console.info('\nffmpeg just wrote ' + chunk.length + ' bytes');
		});
};

const setInputDuration = async (video) => {
	video.user.inputDuration = video.user.inputDuration || 0;
	video._inputs.forEach((inputVideo) => {
		ffmpeg.ffprobe(inputVideo.source, (err, metadata) => {
			if (err) {
				console.debug(JSON.stringify(video, null, 2));
				console.error(err);
				process.exit();
			}

			video.user = video.user || {};
			try {
				video.user.inputDuration += metadata.format.duration * 1000;
			} catch (e) {
				console.debug(JSON.stringify(metadata, null, 2));
				console.error(e);
				process.exit();
			}
		});
	});

	let counter = 0;
	while (video.user?.inputDuration === undefined) {
		if (counter >= 120) {
			console.log('[ ERROR ] took too long to set inputDuration');
		}
		await delay(500);
		counter++;
	}
};

const setCallback = (video, ...callbacks) => {
	video.on('end', () => {
		if (Array.isArray(callbacks)) {
			(callbacks.map((callback) => async () => {
				if (typeof callback === 'function') {
					await callback();
				}
			})).reduce((p, func) => p.then(func), Promise.resolve());
		}
	})
};

const joinVideos = async (dirPath) => {
	const videoFilepath = dirPath.replace(/\.split$/, '');
	const destPath = videoFilepath.replace(new RegExp(`^${backupPath.replace(/\\/g, '\\\\')}`), plexMediaPath);
	if (!fs.existsSync(destPath.replace(/(.*)\\.*/, '$1'))) {
		shell.mkdir('-p', destPath.replace(/(.*)\\.*/, '$1'));
	}

	let video = ffmpeg();
	const uuid = uuidv4();

	video.user = video.user || {
		originalSource: dirPath,
		source: videoFilepath,
	};

	setListeners(video, uuid);

	setCallback(video, async () => {
		currentVideos = currentVideos.filter((video) => video.uuid !== uuid);
		fs.writeFileSync(restoreLogFilepath, `${video.user.originalSource}\n`, { flag: 'a+' });
		advanceQueue();
	});

	fs.readdirSync(dirPath).forEach((filename) => {
		const filepath = path.join(dirPath, filename);
		video.mergeAdd(filepath);
	});

	await setInputDuration(video);
	video.user.outputDuration = video.user.inputDuration;
  videoQueue.push({ uuid, video, destPath });
  if (currentVideos.length < maxConcurrentVideos) {
  	advanceQueue();
  }
};

const advanceQueue = async () => {
	const videoObj = videoQueue.shift();
	if (videoObj) {
		const {
			uuid,
			video,
			destPath
		} = videoObj;

		const tempMergeDir = path.join(tempDir, uuid);
		if (!fs.existsSync(tempMergeDir)) {
			shell.mkdir('-p', tempMergeDir);
		}

    console.info(`\n${'-'.repeat(video.user.source.length + 8)}`);
    console.info(`\n    ${video.user.source}\n`);
    console.info(`${'-'.repeat(video.user.source.length + 8)}`);
		currentVideos.push(videoObj);
		video.mergeToFile(destPath, tempMergeDir);
	}
}

const parseDir = (mediaPath, mediaDir) => {
	fs.readdirSync(mediaPath).map((name) => {
		const filepath = path.join(mediaPath, name);
		if (restored.includes(filepath)) {
			return;
		}

		const item = fs.lstatSync(filepath);
		if (item.isDirectory()) {
			if (filepath.match(/\.split$/)) {
				joinVideos(filepath);
			} else {
				parseDir(filepath, mediaDir);
			}
		} else if (item.isFile()) {
			const destMediaDir = path.join(plexMediaPath, mediaPath.replace(backupPath, ''));
			let destPath = path.join(destMediaDir, name);

			if (!fs.existsSync(destMediaDir)) {
				shell.mkdir('-p', destMediaDir);
			}

			console.info(`\n${'-'.repeat(filepath.length + 8)}`);
			console.info(`\n    ${filepath}\n`);
			console.info(`${'-'.repeat(filepath.length + 8)}`);
			fs.copyFileSync(filepath, destPath);
			fs.writeFileSync(restoreLogFilepath, `${filepath}\n`, { flag: 'a+' });
		}
	});
};

const main = () => {
	plexMediaDirectories.forEach((mediaDir) => parseDir(path.join(backupPath, mediaDir), mediaDir));
};

main();
