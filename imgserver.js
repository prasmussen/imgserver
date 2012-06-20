#!/usr/bin/node

var fs = require("fs");
var path = require("path");
var util = require("util");
var restify = require("restify");
var formidable = require("formidable");
var bunyan = require("bunyan");
var sprintf = util.format;

var APP_NAME = path.basename(process.argv[1], ".js");
var DATASETS_PATH = "datasets";
var DATASETS_FILE = path.join(__dirname, DATASETS_PATH, "datasets.json");

// Read in config and datasets file, blow up on errors
var config = JSON.parse(fs.readFileSync(process.argv[1].replace(/js$/, "") + "config", "utf8"));
var datasets = JSON.parse(fs.readFileSync(DATASETS_FILE, "utf8"));

// Configure restify server
var server = restify.createServer({
    name: APP_NAME,
    log: bunyan.createLogger({
        name: APP_NAME,
        streams: [
            {
              level: "trace",
              stream: process.stdout
            },
            {
              level: "trace",
              path: APP_NAME + ".log"
            }
        ]
    }),
    formatters: {
        "application/json": indentedJSON
    }
});

server.use(restify.queryParser());
server.on("after", restify.auditLogger({
    log: server.log
}));

// Routes
//server.get("/", respond);
//server.get("/ping", respond);
server.get("/datasets", listDatasets);
server.get("/datasets/:id", getDatasetInfo);
server.get("/datasets/:id/:path", getDatasetFile);
server.put("/datasets/:uuid", saveDataset);
//server.del("/datasets/:uuid", deleteDataset);

// Start listening
server.listen(80, function() {
    console.log("%s listening at %s", server.name, server.url);
});


// Routes logic
function listDatasets(req, res) {
    // TODO: filter on query params
    res.json(datasets);
}

function getDatasetInfo(req, res) {
    var id = req.params.id;
    var dataset = findDatasetWithId(id);

    if (!dataset) {
        return error(res, 404, sprintf("Dataset '%s' not found", id));
    }
    res.json(dataset);
}

function getDatasetFile(req, res) {
    var id = req.params.id;
    var fname = req.params.path;

    var dataset = findDatasetWithId(id);
    if (!dataset) {
        return error(res, 404, sprintf("Dataset '%s' not found", id));
    }

    // Check if this dataset contains the requested file
    var found = dataset.files.some(function(file) {
        return fname === file.path;
    });

    if (!found) {
        return error(res, 404, sprintf("Dataset '%s' does not have a '%s' file", id, fname));
    }

    var filePath = path.join(DATASETS_PATH, fname);
    var stat = fs.statSync(filePath);
    
    if (!stat.isFile()) {
        return error(res, 404, "File not found on server");
    }

    // Steam file to client
    res.writeHead(200, {'Content-Length': stat.size});
    util.pump(fs.createReadStream(filePath), res);
}

function saveDataset(req, res) {
    var id = req.params.uuid; 
    var form = new formidable.IncomingForm();
    var manifestErr = null;
    form.uploadDir = DATASETS_PATH;

    var onManifest = function(fpath) {
        var manifest;
        try {
            manifest = JSON.parse(fs.readFileSync(fpath, "utf8"));
        } catch(err) {
            return sprintf("Error parsing manifest file (%s)", err.toString());
        }

        if (id !== manifest.uuid) {
            return sprintf("UUID param, '%s', does not match the UUID in the uploaded manifest, '%s'", manifest.uuid, id);
        }
        return addManifestToDatasets(manifest);
    };

    form.on("file", function(name, file) {
        console.log("Received " + name);

        // According to the specification, the first file must alway be the manifest file
        if (name === "manifest") {
            manifestErr = onManifest(file.path);
        } 

        // Remove any stored file if there was an error parsing the manifest file
        // or if the manifest havent been received yet
        if (manifestErr || !findDatasetWithId(id)) {
            return fs.unlinkSync(file.path);
        }

        // At this point everything should be ok, so we rename the temp file to its original filename
        var dstPath = path.join(DATASETS_PATH, file.name);
        fs.renameSync(file.path, dstPath);
    });

    // All uploading is done when this callback is called
    form.parse(req, function(err, fields, files) {
        if (err) {
            return error(res, 500, sprintf("Error parsing form (%s)", err.toString()));
        } else if (manifestErr) {
            return error(res, 400, manifestErr);
        }

        var ds = findDatasetWithId(id);
        if (!ds) {
            return error(res, 400, sprintf("Missing manifest for dataset '%s'", id));
        }
        res.json(200, ds);
        res.end();
    });
}

// Helper functions
function error(res, code, message) {
    try {
        res.json(code, {
            code: code,
            message: message
        });
        res.end();
    } catch (err) {
        console.log(err.toString());
    }
}

function findDatasetWithId(uuid) {
    var matches = datasets.filter(function(ds) {
        return uuid === ds.uuid;
    });

    if (matches.length > 0) {
        return matches[0];
    }
    return null;
}

function addManifestToDatasets(manifest) {
    try {
        // Add server generated fields
        manifest.cloud_name = config.cloud_name;
        manifest.creator_uuid = config.creator_uuid;
        manifest.creator_name = config.creator_name;
        manifest.urn = sprintf("%s:%s:%s:%s", manifest.cloud_name, manifest.creator_name, manifest.name, manifest.version);
        manifest.published_at = new Date().toISOString();

        // Update datasets in memory
        var ds = findDatasetWithId(manifest.uuid);
        if (ds) {
            // Remove existing dataset with same uuid
            var idx = datasets.indexOf(ds);
            datasets.splice(idx, 1);
        }
        datasets.push(manifest);

        // Save datasets to file
        fs.writeFileSync(DATASETS_FILE, JSON.stringify(datasets, null, 4));
    } catch(err) {
        return err.toString();
    }
    return null;
}

// Modified original JSON formatter to do indentation
function indentedJSON(req, res, body) {
  if (!body) {
    if (res.getHeader('Content-Length') === undefined &&
        res.contentLength === undefined) {
      res.setHeader('Content-Length', 0);
    }
    return null;
  }

  if (body instanceof Error) {
    // snoop for RestError or HttpError, but don't rely on instanceof
    if ((body.restCode || body.httpCode) && body.body) {
      body = body.body;
    } else {
      body = {
        message: body.message
      };
    }
  }

  if (Buffer.isBuffer(body))
    body = body.toString('base64');

  var data = JSON.stringify(body, null, 4);

  if (res.getHeader('Content-Length') === undefined &&
      res.contentLength === undefined) {
    res.setHeader('Content-Length', Buffer.byteLength(data));
  }

  return data;
}
