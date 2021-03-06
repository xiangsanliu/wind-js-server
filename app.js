let express = require("express");
let moment = require("moment");
let http = require('http');
let request = require('request');
let fs = require('fs');
let Q = require('q');
let cors = require('cors');

let app = express();
let port = process.env.PORT || 7000;
let baseDir = 'http://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl';

// cors config
let whitelist = [
    'http://localhost:63342',
    'http://localhost:3000',
    'http://localhost:4000',
    'http://danwild.github.io'
];

let corsOptions = {
    origin: function (origin, callback) {
        let originIsWhitelisted = whitelist.indexOf(origin) !== -1;
        callback(null, originIsWhitelisted);
    }
};

app.listen(port, function (err) {
    console.log("running server on port " + port);
});

app.get('/', cors(corsOptions), function (req, res) {
    res.send('hello wind-js-server.. go to /latest for wind data..');
});

app.get('/alive', cors(corsOptions), function (req, res) {
    res.send('wind-js-server is alive');
});

app.get('/latest', cors(corsOptions), function (req, res) {
    res.header("Access-Control-Allow-Origin", "*");

    /**
     * Find and return the latest available 6 hourly pre-parsed JSON data
     *
     * @param targetMoment {Object} UTC moment
     */
    function sendLatest(targetMoment) {

        let stamp = moment(targetMoment).format('YYYYMMDD') + roundHours(moment(targetMoment).hour(), 6);
        let fileName = __dirname + "/json-data/" + stamp + ".json";

        res.setHeader('Content-Type', 'application/json');
        res.sendFile(fileName, {}, function (err) {
            if (err) {
                console.log(stamp + ' doesnt exist yet, trying previous interval..');
                sendLatest(moment(targetMoment).subtract(6, 'hours'));
            }
        });
    }

    sendLatest(moment().utc());

});

app.get('/nearest', cors(corsOptions), function (req, res, next) {

    let time = req.query.timeIso;
    let limit = req.query.searchLimit;
    let searchForwards = false;

    /**
     * Find and return the nearest available 6 hourly pre-parsed JSON data
     * If limit provided, searches backwards to limit, then forwards to limit before failing.
     *
     * @param targetMoment {Object} UTC moment
     */
    function sendNearestTo(targetMoment) {

        if (limit && Math.abs(moment.utc(time).diff(targetMoment, 'days')) >= limit) {
            if (!searchForwards) {
                searchForwards = true;
                sendNearestTo(moment(targetMoment).add(limit, 'days'));
                return;
            } else {
                return next(new Error('No data within searchLimit'));
            }
        }

        let stamp = moment(targetMoment).format('YYYYMMDD') + roundHours(moment(targetMoment).hour(), 6);
        let fileName = __dirname + "/json-data/" + stamp + ".json";

        res.setHeader('Content-Type', 'application/json');
        res.sendFile(fileName, {}, function (err) {
            if (err) {
                let nextTarget = searchForwards ? moment(targetMoment).add(6, 'hours') : moment(targetMoment).subtract(6, 'hours');
                sendNearestTo(nextTarget);
            }
        });
    }

    if (time && moment(time).isValid()) {
        sendNearestTo(moment.utc(time));
    } else {
        return next(new Error('Invalid params, expecting: timeIso=ISO_TIME_STRING'));
    }

});

/**
 *
 * Ping for new data every 15 mins
 *
 */
setInterval(function () {

    run(moment.utc());

}, 900000);

/**
 *
 * @param targetMoment {Object} moment to check for new data
 */
function run(targetMoment) {

    getGribData(targetMoment).then(function (response) {
        if (response.stamp) {
            convertGribToJson(response.stamp, response.targetMoment);
        }
    });
}

/**
 *
 * Finds and returns the latest 6 hourly GRIB2 data from NOAAA
 *
 * @returns {*|promise}
 */
function getGribData(targetMoment) {

    let deferred = Q.defer();

    function runQuery(targetMoment) {

        // 下载最近7天的数据
        if (moment.utc().diff(targetMoment, 'days') > 7) {
            console.log('hit limit, harvest complete or there is a big gap in data..');
            return;
        }

        let fileUrlName = 'gfs.t' + roundHours(moment(targetMoment).hour(), 6) + 'z.pgrb2.0p25.f000';

        let stamp = moment(targetMoment).format('YYYYMMDD') + roundHours(moment(targetMoment).hour(), 6);

        request.get({
            url: baseDir,
            qs: {
                file: fileUrlName,
                lev_1000_mb: 'on',
                // lev_surface: 'on',
                // var_TMP: 'on',
                var_UGRD: 'on',
                var_VGRD: 'on',
                leftlon: 115,
                rightlon: 117,
                toplat: 30,
                bottomlat: 28,
                dir: '/gfs.' + moment(targetMoment).format('YYYYMMDD') + '/' + roundHours(moment(targetMoment).hour(), 6)
            }

        }).on('error', function (err) {
            // console.log(err);
            runQuery(moment(targetMoment).subtract(6, 'hours'));

        }).on('response', function (response) {

            console.log('response ' + response.statusCode + ' | ' + stamp);

            if (response.statusCode !== 200) {
                runQuery(moment(targetMoment).subtract(6, 'hours'));
            } else {
                // don't rewrite stamps
                if (!checkPath('json-data/' + stamp + '.json', false)) {

                    console.log('piping ' + stamp);

                    // mk sure we've got somewhere to put output
                    checkPath('grib-data', true);

                    // pipe the file, resolve the valid time stamp
                    let file = fs.createWriteStream("grib-data/" + stamp + ".f000");
                    response.pipe(file);
                    file.on('finish', function () {
                        file.close();
                        deferred.resolve({stamp: stamp, targetMoment: targetMoment});
                    });

                } else {
                    console.log('already have ' + stamp + ', not looking further');
                    deferred.resolve({stamp: false, targetMoment: false});
                }
            }
        });

    }

    runQuery(targetMoment);
    return deferred.promise;
}

function convertGribToJson(stamp, targetMoment) {

    // mk sure we've got somewhere to put output
    checkPath('json-data', true);

    let exec = require('child_process').exec, child;

    child = exec('converter/bin/grib2json --data --output json-data/' + stamp + '.json --names --compact grib-data/' + stamp + '.f000',
        {maxBuffer: 500 * 1024},
        function (error, stdout, stderr) {

            if (error) {
                console.log('exec error: ' + error);
            } else {
                console.log("converted..");

                // don't keep raw grib data
                exec('rm grib-data/*');

                // if we don't have older stamp, try and harvest one
                let prevMoment = moment(targetMoment).subtract(6, 'hours');
                let prevStamp = prevMoment.format('YYYYMMDD') + roundHours(prevMoment.hour(), 6);

                if (!checkPath('json-data/' + prevStamp + '.json', false)) {

                    console.log("attempting to harvest older data " + stamp);
                    run(prevMoment);
                } else {
                    console.log('got older, no need to harvest further');
                }
            }
        });
}

/**
 *
 * Round hours to expected interval, e.g. we're currently using 6 hourly interval
 * i.e. 00 || 06 || 12 || 18
 *
 * @param hours
 * @param interval
 * @returns {String}
 */
function roundHours(hours, interval) {
    if (interval > 0) {
        let result = (Math.floor(hours / interval) * interval);
        return result < 10 ? '0' + result.toString() : result;
    }
}

/**
 * Sync check if path or file exists
 *
 * @param path {string}
 * @param mkdir {boolean} create dir if doesn't exist
 * @returns {boolean}
 */
function checkPath(path, mkdir) {
    try {
        fs.statSync(path);
        return true;

    } catch (e) {
        if (mkdir) {
            fs.mkdirSync(path);
        }
        return false;
    }
}

// init harvest
run(moment.utc());