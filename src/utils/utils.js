// Miscellaneous utilities
/*jshint worker: true*/

import log from './log';
import Thread from './thread';
import WorkerBroker from './worker_broker';
import Geo from '../geo';

var Utils;
export default Utils = {};

WorkerBroker.addTarget('Utils', Utils);

// Basic Safari detection
// http://stackoverflow.com/questions/7944460/detect-safari-browser
Utils.isSafari = function () {
    return /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
};

// Basic IE11 or Edge detection
Utils.isMicrosoft = function () {
    return /(Trident\/7.0|Edge[ /](\d+[\.\d]+))/i.test(navigator.userAgent);
};

Utils._requests = {};       // XHR requests on current thread
Utils._proxy_requests = {}; // XHR requests proxied to main thread

// `request_key` is a user-provided key that can be later used to cancel the request
Utils.io = function (url, timeout = 60000, responseType = 'text', method = 'GET', headers = {}, request_key = null, proxy = false) {
    if (Thread.is_worker && Utils.isMicrosoft()) {
        // Some versions of IE11 and Edge will hang web workers when performing XHR requests
        // These requests can be proxied through the main thread
        // https://developer.microsoft.com/en-us/microsoft-edge/platform/issues/9545866/
        log('debug', 'Proxying request for URL to worker', url);

        if (request_key) {
            Utils._proxy_requests[request_key] = true; // mark as proxied
        }
        return WorkerBroker.postMessage('Utils.io', url, timeout, responseType, method, headers, request_key, true);
    }
    else {
        var request = new XMLHttpRequest();
        var promise = new Promise((resolve, reject) => {
            request.open(method, url, true);
            request.timeout = timeout;
            request.responseType = responseType;
            request.onload = () => {
                if (request.status === 200) {
                    if (['text', 'json'].indexOf(request.responseType) > -1) {
                        resolve(request.responseText);
                    }
                    else {
                        resolve(request.response);
                    }
                } else {
                    reject(Error('Request error with a status of ' + request.statusText));
                }
            };
            request.onerror = (evt) => {
                reject(Error('There was a network error' + evt.toString()));
            };
            request.ontimeout = (evt) => {
                reject(Error('timeout '+ evt.toString()));
            };
            request.send();
        });

        promise = promise.then(response => {
            if (request_key) {
                delete Utils._requests[request_key];
            }

            if (proxy) {
                return WorkerBroker.withTransferables(response);
            }
            return response;
        });

        if (request_key) {
            Utils._requests[request_key] = request;
        }

        return promise;
    }
};

// Çancel a pending network request by user-provided request key
Utils.cancelRequest = function (key) {
    // Check for a request that was proxied to the main thread
    if (Thread.is_worker && Utils._proxy_requests[key]) {
        return WorkerBroker.postMessage('Utils.cancelRequest', key); // forward to main thread
    }

    let req = Utils._requests[key];
    if (req) {
        log('trace', `Cancelling network request key '${key}'`);
        Utils._requests[key].abort();
        delete Utils._requests[key];
    }
    else {
        log('trace', `Could not find network request key '${key}'`);
    }
};

// Needed for older browsers that still support WebGL (Safari 6 etc.)
Utils.requestAnimationFramePolyfill = function () {
    if (typeof window.requestAnimationFrame !== 'function') {
        window.requestAnimationFrame =
            window.webkitRequestAnimationFrame ||
            window.mozRequestAnimationFrame    ||
            window.oRequestAnimationFrame      ||
            window.msRequestAnimationFrame     ||
            function (cb) {
                setTimeout(cb, 1000 /60);
            };
    }
};

// Stringify an object into JSON, but convert functions to strings
Utils.serializeWithFunctions = function (obj) {
    if (typeof obj === 'function') {
        return obj.toString();
    }

    let serialized = JSON.stringify(obj, function(k, v) {
        // Convert functions to strings
        if (typeof v === 'function') {
            return v.toString();
        }
        return v;
    });

    return serialized;
};

// Recursively parse an object, attempting to convert string properties that look like functions back into functions
Utils.stringsToFunctions = function(obj, wrap) {
    // Convert string
    if (typeof obj === 'string') {
        obj = Utils.stringToFunction(obj, wrap);
    }
    // Loop through object properties
    else if (obj != null && typeof obj === 'object') {
        for (let p in obj) {
            obj[p] = Utils.stringsToFunctions(obj[p], wrap);
        }
    }
    return obj;
};

// Convert string back into a function
Utils.stringToFunction = function(val, wrap) {
    // Parse function signature and body
    let fmatch =
        (typeof val === 'string') &&
        val.match(/^\s*function[^(]*\(([^)]*)\)\s*?\{([\s\S]*)\}$/m);

    if (fmatch && fmatch.length > 2) {
        try {
            let src = fmatch[2];
            let args = fmatch[1].length > 0 && fmatch[1].split(',').map(x => x.trim()).filter(x => x);
            args = args.length > 0 ? args : ['context']; // default to single 'context' argument

            if (typeof wrap === 'function') {
                return new Function(args.toString(), wrap(src)); // jshint ignore:line
            }
            else {
                return new Function(args.toString(), src); // jshint ignore:line
            }
        }
        catch (e) {
            // fall-back to original value if parsing failed
            return val;
        }
    }
    return val;
};

// Default to allowing high pixel density
// Returns true if display density changed
Utils.use_high_density_display = true;
Utils.updateDevicePixelRatio = function () {
    let prev = Utils.device_pixel_ratio;
    Utils.device_pixel_ratio = (Utils.use_high_density_display && window.devicePixelRatio) || 1;
    return Utils.device_pixel_ratio !== prev;
};

if (Thread.is_main) {
    Utils.updateDevicePixelRatio();
}

// Used for differentiating between power-of-2 and non-power-of-2 textures
// Via: http://stackoverflow.com/questions/19722247/webgl-wait-for-texture-to-load
Utils.isPowerOf2 = function(value) {
    return (value & (value - 1)) === 0;
};

// Interpolate 'x' along a series of control points
// 'points' is an array of control points in the form [x, y]
//
// Example:
//     Control points:
//         [0, 5]:  when x=0, y=5
//         [4, 10]: when x=4, y=10
//
//     Utils.interpolate(2, [[0, 5], [4, 10]]);
//     -> computes x=2, halfway between x=0 and x=4: (10 - 5) / 2 +5
//     -> returns 7.5
//
// TODO: add other interpolation methods besides linear
//
Utils.interpolate = function(x, points, transform) {
    // If this doesn't resemble a list of control points, just return the original value
    if (!Array.isArray(points) || !Array.isArray(points[0])) {
        return points;
    }
    else if (points.length < 1) {
        return points;
    }

    var x1, x2, d, y, y1, y2;

    // Min bounds
    if (x <= points[0][0]) {
        y = points[0][1];
        if (typeof transform === 'function') {
            y = transform(y);
        }
    }
    // Max bounds
    else if (x >= points[points.length-1][0]) {
        y = points[points.length-1][1];
        if (typeof transform === 'function') {
            y = transform(y);
        }
    }
    // Find which control points x is between
    else {
        for (var i=0; i < points.length - 1; i++) {
            if (x >= points[i][0] && x < points[i+1][0]) {
                // Linear interpolation
                x1 = points[i][0];
                x2 = points[i+1][0];

                // Multiple values
                if (Array.isArray(points[i][1])) {
                    y = [];
                    for (var c=0; c < points[i][1].length; c++) {
                        if (typeof transform === 'function') {
                            y1 = transform(points[i][1][c]);
                            y2 = transform(points[i+1][1][c]);
                            d = y2 - y1;
                            y[c] = d * (x - x1) / (x2 - x1) + y1;
                        }
                        else {
                            d = points[i+1][1][c] - points[i][1][c];
                            y[c] = d * (x - x1) / (x2 - x1) + points[i][1][c];
                        }
                    }
                }
                // Single value
                else {
                    if (typeof transform === 'function') {
                        y1 = transform(points[i][1]);
                        y2 = transform(points[i+1][1]);
                        d = y2 - y1;
                        y = d * (x - x1) / (x2 - x1) + y1;
                    }
                    else {
                        d = points[i+1][1] - points[i][1];
                        y = d * (x - x1) / (x2 - x1) + points[i][1];
                    }
                }
                break;
            }
        }
    }
    return y;
};

Utils.toCSSColor = function (color) {
    if (color[3] === 1) { // full opacity
        return `rgb(${color.slice(0, 3).map(c => Math.round(c * 255)).join(', ')})`;
    }
    // RGB is between [0, 255] opacity is between [0, 1]
    return `rgba(${color.map((c, i) => (i < 3 && Math.round(c * 255)) || c).join(', ')})`;
};

Utils.pointInTile2 = function (min, max, anchor) {
    if (anchor == 'right' && min[0] >=0 && max[0] >=0 && min[0] < Geo.tile_scale && max[0] < Geo.tile_scale)
        return true;
    else if (anchor == 'left' && min[0] >=0 && max[0] >=0 && min[0] < Geo.tile_scale && max[0] < Geo.tile_scale)
        return true;
    else if (anchor == 'bottom' && min[1] > -Geo.tile_scale && max[1] > -Geo.tile_scale && min[1] <= 0 && max[1] <= 0)
        return true;
    else if (anchor == 'top' && min[1] > -Geo.tile_scale && max[1] > -Geo.tile_scale && min[1] <= 0 && max[1] <= 0)
        return true;
    return false;
};

Utils.pointInTile = function (point) {
    return point[0] >= 0 && point[1] > -Geo.tile_scale && point[0] < Geo.tile_scale && point[1] <= 0;
};

Utils.wrap = function (n, min, max) {
    const d = max - min;
    const w = ((n - min) % d + d) % d + min;
    return (w === min) ? max : w;
};

Utils.clamp = function (n, min, max) {
    return Math.min(max, Math.max(min, n));
};

Utils.bindAll = function(fns, context) {
    fns.forEach((fn) => {
        if (!context[fn]) { return; }
        context[fn] = context[fn].bind(context);
    });
};