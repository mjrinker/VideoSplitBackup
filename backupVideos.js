const delay = require('delay');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const shell = require('shelljs');
const { v4: uuidv4 } = require('uuid');

const maxConcurrentVideos = 3;
const maxFileSize = 2 * 1000 * 1000 * 1000; // 2GB
const plexMediaPath = 'P:\\Media';
const mediaDestPath = 'D:\\Media';
const backupLogFilepath = path.join(plexMediaPath, 'backup.log');
const plexMediaDirectories = [
	'Audiobooks',
	'Courses',
	'Church Movies',
	'Home Videos',
	'Movies',
	'TV Shows',
];

const videoExtensions = ['avi', 'mpg', 'mp2', 'mpeg', 'mpe', 'mpv', 'mp4', 'm4p', 'm4v', 'ogg', 'wmv', 'mov', 'qt', 'webm', 'flv', 'swf'];
let backedUp = [];
let currentVideos = [];
const videoQueue = [];

if (fs.existsSync(backupLogFilepath)) {
	backedUp = String(fs.readFileSync(backupLogFilepath)).split('\n');
}

if (!fs.existsSync(mediaDestPath)) {
	fs.mkdirSync(mediaDestPath);
}

process.on('unhandledRejection', (error) => {
	console.error(error);
	process.exit();
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
		  		progressPercent = (((timeStringToMilliseconds(progress.timemark) / video.user.outputDuration)) * 100).toFixed(2);
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
	ffmpeg.ffprobe(video.options.source, (err, metadata) => {
		video.user = video.user || {};
		video.user.inputDuration = metadata.format.duration * 1000;
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

const saveVideoPartition = (uuid, video, destPath, numPartitions, index = 0) => {
	const name = destPath.substring(destPath.lastIndexOf('\\') + 1);

	if (index + 1 > numPartitions) {
		if (index + 1 == numPartitions + 1) {
			video.user.outputDuration = (video.user.inputDuration - (video.user.outputDuration * numPartitions));
			setCallback(video, () => {
				currentVideos = currentVideos.filter((video) => video.uuid !== uuid);
				fs.writeFileSync(backupLogFilepath, `${video.options.source}\n`, { flag: 'a+' });
				advanceQueue();
			});
		} else {
			return;
		}
	} else {
		setCallback(video, async () => {
			const nextVideo = ffmpeg(video.options.source);
			nextVideo.user = nextVideo.user || {};
			setListeners(nextVideo, uuid);
			nextVideo.user.inputDuration = video.user.inputDuration
			nextVideo.user.outputDuration = nextVideo.user.inputDuration / numPartitions;
			saveVideoPartition(uuid, nextVideo, destPath, numPartitions, index + 1);
		});
	}

	const startTime = (video.user.outputDuration * index) / 1000;
	const duration = video.user.outputDuration / 1000;

	if (duration <= 0) {
		currentVideos = currentVideos.filter((video) => video.uuid !== uuid);
		fs.writeFileSync(backupLogFilepath, `${video.options.source}\n`, { flag: 'a+' });
		advanceQueue();
		return;
	}

	video.setStartTime(startTime)
		.duration(duration)
		.save(path.join(destPath, `${name.replace(/\.\w+$/, '')} - ${index}${path.extname(video.options.source)}`));
};

const advanceQueue = async () => {
		const videoObj = videoQueue.shift();
		if (videoObj) {
			const {
				uuid,
				video,
				destPath,
				numPartitions,
			} = videoObj;
	    console.info(`\n${'-'.repeat(video.options.source.length + 8)}`);
	    console.info(`\n    ${video.options.source}\n`);
	    console.info(`${'-'.repeat(video.options.source.length + 8)}`);
			currentVideos.push(videoObj);
			saveVideoPartition(uuid, video, destPath, numPartitions);
		}
}

const parseDir = (mediaPath, mediaDir) => {
	(fs.readdirSync(mediaPath).map((name) => async () => {
		const filepath = path.join(mediaPath, name);
		if (backedUp.includes(filepath)) {
			return;
		}

		const item = fs.lstatSync(filepath);
		if (item.isFile()) {
			const destMediaDir = path.join(mediaDestPath, mediaPath.replace(plexMediaPath, ''));
			let destPath = path.join(destMediaDir, name);

			if (!fs.existsSync(destMediaDir)) {
				shell.mkdir('-p', destMediaDir);
			}

			if (videoExtensions.includes(path.extname(filepath).replace(/^\./, ''))) {
				const size = fs.statSync(filepath).size;
				if (size > maxFileSize) {
					destPath = `${destPath}.split`;
					if (!fs.existsSync(destPath)) {
						fs.mkdirSync(destPath);
					}

					const numPartitions = Math.floor(size / maxFileSize) + 1;

					const video = ffmpeg(filepath);
					const uuid = uuidv4();

					video.user = video.user || {};
					setListeners(video, uuid);
					await setInputDuration(video);
					video.user.outputDuration = video.user.inputDuration / numPartitions;
			    videoQueue.push({ uuid, video, destPath, numPartitions });
			    if (currentVideos.length < maxConcurrentVideos) {
			    	advanceQueue();
			    }
				} else {
					console.info(`\n${'-'.repeat(filepath.length + 8)}`);
			    console.info(`\n    ${filepath}\n`);
			    console.info(`${'-'.repeat(filepath.length + 8)}`);
					fs.copyFileSync(filepath, destPath);
					fs.writeFileSync(backupLogFilepath, `${filepath}\n`, { flag: 'a+' });
				}
			} else {
				console.info(`\n${'-'.repeat(filepath.length + 8)}`);
				console.info(`\n    ${filepath}\n`);
				console.info(`${'-'.repeat(filepath.length + 8)}`);
				fs.copyFileSync(filepath, destPath);
				fs.writeFileSync(backupLogFilepath, `${filepath}\n`, { flag: 'a+' });
			}
		} else if (item.isDirectory()) {
			parseDir(filepath, mediaDir);
		}
	})).reduce((p, func) => p.then(func), Promise.resolve());
};

const main = () => {
	plexMediaDirectories.forEach((mediaDir) => parseDir(path.join(plexMediaPath, mediaDir), mediaDir));
};

main();
