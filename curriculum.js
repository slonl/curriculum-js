

var curriculum = (function(curriculum){

    curriculum.sources = {};

    curriculum.schemas = {};

	curriculum.schema = {};

    curriculum.index = {
        id: {},
        type: {},
        schema: {},
		references: {},
		deprecated: {}
    };

    curriculum.data = {};

    curriculum.errors = [];

    curriculum.clone = function(ob) {
        if (typeof ob == 'undefined' || ob == null) {
            return null;
        }
        return JSON.parse(JSON.stringify(ob));
    }

	curriculum.parseSchema = function(schema) {
		if (typeof $RefParser == 'undefined') {
			console.error('json schema ref parser not loaded');
			return;
		}
		if (typeof _ == 'undefined' ) {
			console.error('lodash not loaded');
			return;
		}
        var resolveAllOf = (function() {
            // from https://github.com/mokkabonna/json-schema-merge-allof
            var customizer = function (objValue, srcValue) {
                if (_.isArray(objValue)) {
                    return _.union(objValue, srcValue);
                }
                return;
            };
            return function(inputSpec) {
                if (inputSpec && typeof inputSpec === 'object') {
                    if (Object.keys(inputSpec).length > 0) {
                        if (inputSpec.allOf) {
                            var allOf = inputSpec.allOf;
                            delete inputSpec.allOf;
                            var nested = _.mergeWith.apply(_, [{}].concat(allOf, [customizer]));
                            inputSpec = _.defaultsDeep(inputSpec, nested, customizer);
                        }
                        Object.keys(inputSpec).forEach(function (key) {
                            inputSpec[key] = resolveAllOf(inputSpec[key]);
                        });
                    }
                }
                return inputSpec;
            }
        })();
		return $RefParser.dereference(schema)
		.then(function(schema) {
			return resolveAllOf(schema);
		});
	}

    curriculum.loadContextFromURL = function(name, url) {
        curriculum.sources[name] = {
            method: 'url',
            source: url,
            state: 'loading'
        };
        return fetch(url)
        .then(function(result) {
            if (result.ok) {
                curriculum.sources[name].state = 'parsing';
                return result.json();
            }
            throw new Error(result.statusText, result.status);
        })
        .then(function(json) {
            curriculum.schemas[name] = json;
            curriculum.sources[name].state = 'available';
            return json;
        });
    };

    curriculum.loadContextFromFile = function(name, fileName) {
        curriculum.sources[name] = {
            method: 'file',
            source: fileName,
            state: 'loading'
        };
        return new Promise(function(resolve, reject) {
            fs.readFile(
                fileName, 
                'utf8', 
                function(err, data) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(data);
                    }
                }
            );
        })
        .then(function(result) {
            return JSON.parse(result);
        })
        .then(function(json) {
            curriculum.schemas[name] = json;
            curriculum.sources[name].state = 'available';
            return json;
        });
    }

    curriculum.loadContextFromGithub = function(name, repository, user, password, branchName) {
		if (!branchName) {
			branchName = 'master';
		}
        curriculum.sources[name] = {
            method: 'github',
            source: repository,
			branch: branchName,
            state: 'loading'
        };
        var branchName = 'editor';
        var gh = new GitHub({username:user, password: password});
        var repoUser = repository.split('/')[0];
        var repoName = repository.split('/')[1];
        var repo, branch = null;

        var getFile = function(filename, list) {
            var nodes = filename.split('/');
            var node = nodes.shift();
            var entry = list.data.tree.filter(function(file) {
                return file.path == node;
            }).pop();
            hash = entry.sha;
            if (nodes.length) {
                return repo.getTree(hash).then(function(list) {
                    return getFile(nodes.join('/'), list);
                });
            } else {
                return repo.getBlob(hash).then(function(data) {
                    return data.data;
                });
            }
        };

        if (gh.getUser()) {
            var repo = gh.getRepo(repoUser, repoName);
            curriculum.sources[name].repo = repo;
            curriculum.sources[name].getFile = function(filename) {
                return repo.getBranch(branchName)
                .then(function(branchOb) {
                    branch = branchOb;
                    return branch.data.commit.sha;
                })
                .then(function(lastCommit) {
                    return repo.getTree(lastCommit).then(function(list) {
                        return getFile(filename, list);
                    });
                });
            };

            curriculum.sources[name].writeFile = function(filename, data, message) {
                return repo.writeFile(branchName,filename,data,message,{encode:true});
            };
            curriculum.sources[name].writeFiles = function(files, message) {
                var blobs = [];
                var treeItems = [];
                Object.keys(files).forEach(function(filename) {
                    blobs.push(repo.createBlob(files[filename]).then(function(blob) {
                        treeItems.push({
                            path: filename,
                            sha: blob.sha,
                            mode: '100644',
                            type: 'blob'
                        });
                    }));
                });
                return Promise.all(blobs).then(function(blobs) {
                    repo.getBranch(branchName)
                    .then(function(branchOb) {
                        branch = branchOb;
                        return branch.data.commit.sha;
                    })
                    .then(function(lastCommit) {
                        //FIXME: should keep track of commit that was loaded, if lastCommit is differen
                        //we may need to merge first
                        repo.createTree(treeItems, lastCommit)
                        .then(function(tree) {
                            return repo.commit(lastCommit, tree.sha, message);
                        });
                    });
                });
            };

            return curriculum.sources[name].getFile('context.json')
            .then(function(json) {
                curriculum.schemas[name] = json;
                curriculum.sources[name].state = 'available';
                return json;
            });
        } else {
            return Promise.reject({ message: 'Access denied', code: 401});
        }
    };

	function updateReferences(object) {
		Object.keys(object).forEach(k => {
			if (Array.isArray(object[k]) 
				&& ( k.substr(k.length-3)=='_id'
					|| k=='replaces'
					|| k=='replacedBy')
			) {
				object[k].forEach(id => {
					if (!curriculum.index.references[id]) {
						curriculum.index.references[id] = [];
					}
					curriculum.index.references[id].push(object.id);
				});
			} else if (k.substr(k.length-3)=='_id'
				&& typeof object[k]=='string'
			) {
				var id = object[k];
				if (!curriculum.index.references[id]) {
					curriculum.index.references[id] = [];
				}
				curriculum.index.references[id].push(object.id);
			}
		});
	}

    curriculum.loadData = function(name) {
        var schema = curriculum.schemas[name];
        var data = {};

        var properties = Object.keys(schema.properties);
        properties.forEach(function(propertyName) {
            if (typeof(schema.properties[propertyName]['#file']) != 'undefined') {
                data[propertyName] = (function() {
                    switch(curriculum.sources[name].method) {
                        case 'url':
                            var baseURL = dirname(curriculum.sources[name].source);
                            return fetch(baseURL + schema.properties[propertyName]['#file'])
                            .then(function(result) {
                                if (result.ok) {
                                    return result.json();
                                }
                                throw new Error(result.statusText, result.status);
                            });
                        break;
                        case 'file':
                            var baseDir = dirname(curriculum.sources[name].source);
                            return new Promise(function(resolve,reject) {
                                fs.readFile(
                                    baseDir + schema.properties[propertyName]['#file'], 
                                    'utf8', 
                                    function(err, data) {
                                        if (err) {
                                            reject(err);
                                        } else {
                                            resolve(data);
                                        }
                                    }
                                );
                            })
                            .then(function(result) {
                                return JSON.parse(result);
                            });
                        break;
                        case 'github':
                            return curriculum.sources[name].getFile(schema.properties[propertyName]['#file']);
                        break;
                        default:
                            throw new Error('Unknown loading method '+curriculum.sources[name].method);
                        break;
                    }
                })();
            } else {
                data[propertyName] = [];
            }
        });

		var deleted = [];
        return Promise.all(Object.values(data))
        .then(function(results) {
            Object.keys(data).forEach(function(propertyName) {
                if (/deprecated/.exec(propertyName)) {
					data[propertyName].then(function(entities) {
						if (!curriculum.data.deprecated) {
							curriculum.data.deprecated = [];
						}
						curriculum.data.deprecated = curriculum.data.deprecated.concat(entities);
						entities.forEach(function(entity) {
							if (entity.id) {
								curriculum.index.deprecated[entity.id] = entity;
							}
						});
					});
                    return;
                }
                data[propertyName].then(function(entities) {
                    console.log('index size '+Object.keys(curriculum.index.id).length);
                    console.log('indexing '+name+'.'+propertyName+' ('+entities.length+')');
                    if (!curriculum.data[propertyName]) {
                        curriculum.data[propertyName] = [];
                    }
                    Array.prototype.push.apply(curriculum.data[propertyName],entities);

					if (!curriculum.schema[name]) {
						curriculum.schema[name] = {};
					}
					if (!curriculum.schema[name][propertyName]) {
						curriculum.schema[name][propertyName] = [];
					}
					Array.prototype.push.apply(curriculum.schema[name][propertyName],entities);

                    var count = 0;
                    entities.forEach(function(entity) {
                        if (entity.id) {
                            if (curriculum.index.id[entity.id]) {
                                curriculum.errors.push('Duplicate id in '+name+'.'+propertyName+': '+entity.id);
							} else if (entity.deleted==1 || entity.deleted==true) {
								entity.types = [ propertyName ];
								entity.replacedBy = [];
								curriculum.index.id[entity.id] = entity;
								curriculum.index.type[entity.id] = 'deprecated';
								curriculum.index.schema[entity.id] = name;
								updateReferences(entity);
								deleted.push(entity.id);
                            } else {
                                curriculum.index.id[entity.id] = entity;
                                curriculum.index.type[entity.id] = propertyName;
                                curriculum.index.schema[entity.id] = name;
								updateReferences(entity);
                            }
                        } else {
                            curriculum.errors.push('Missing id in '+name+'.'+propertyName+': '+count);
                        }
                        count++;
                    });
                });
            });
            return data;
        })
		.then(function() {
			// returns arr1 with only ids that are not in arr2
			var arrayDiff = function(arr1, arr2) {
				return arr1.filter(function(id) {
					return arr2.indexOf(id)===-1;
				});
			};
			Object.keys(curriculum.data).forEach(function(propertyName) {
				curriculum.data[propertyName].forEach(function(entity) {
					Object.keys(entity).forEach(function(prop) {
						if (prop.substr(-3)=='_id' && Array.isArray(entity[prop])) {
							entity[prop] = arrayDiff(entity[prop], deleted);
						}
					});
				});
			});
		});
    };

    curriculum.getSchemaFromType = function(type) {
        return Object.keys(curriculum.schemas).reduce(function(acc, schema) {
            if (typeof curriculum.schemas[schema].properties[type] != 'undefined') {
                return schema;
            }
            return acc;
        }, '');
    };

    curriculum.uuidv4 = function(options, buf, offset) {
        var i = buf && offset || 0;

        if (typeof(options) == 'string') {
            buf = options === 'binary' ? new Array(16) : null;
            options = null;
        }
        options = options || {};

        var rnds = options.random || (options.rng || rng)();

        // Per 4.4, set bits for version and lock_seq_hi_and_reserved
        rnds[6] = (rnds[6] & 0x0f) | 0x40;
        rnds[8] = (rnds[8] & 0x3f) | 0x80;

        // Copy bytes to buffer, if provided
        if (buf) {
            for (var ii = 0; ii < 16; ++ii) {
                buf[i + ii] = rnds[ii];
            }
        }

        return buf || bytesToUuid(rnds);
    }

    function dirname(path) {
        return path.replace(/\\/g,'/').replace(/\/[^\/]*$/, '/');;
    };

    var rng = (function() {
        if (typeof require != 'undefined') {
            var crypto = require('crypto');
        }
        if (crypto && crypto.randomBytes) {
            return function() {
                return crypto.randomBytes(16);
            }
        }
        var getRandomValues = (typeof(crypto) != 'undefined' && crypto.getRandomValues && crypto.getRandomValues.bind(crypto)) ||
                      (typeof(msCrypto) != 'undefined' && typeof window.msCrypto.getRandomValues == 'function' && msCrypto.getRandomValues.bind(msCrypto));

        if (getRandomValues) {
            // WHATWG crypto RNG - http://wiki.whatwg.org/wiki/Crypto
            var rnds8 = new Uint8Array(16); // eslint-disable-line no-undef

            return function() {
                getRandomValues(rnds8);
                return rnds8;
            };
        } else {
            // Math.random()-based (RNG)
            //
            // If all else fails, use Math.random().  It's fast, but is of unspecified
            // quality.
            var rnds = new Array(16);

            return function() {
                for (var i = 0, r; i < 16; i++) {
                    if ((i & 0x03) === 0) r = Math.random() * 0x100000000;
                    rnds[i] = r >>> ((i & 0x03) << 3) & 0xff;
                }
                return rnds;
            };
        }
    })();

    var byteToHex = [];
    for (var i = 0; i < 256; ++i) {
        byteToHex[i] = (i + 0x100).toString(16).substr(1);
    }

    function bytesToUuid(buf, offset) {
        var i = offset || 0;
        var bth = byteToHex;
        // join used to fix memory issue caused by concatenation: https://bugs.chromium.org/p/v8/issues/detail?id=3175#c4
        return ([bth[buf[i++]], bth[buf[i++]], 
        bth[buf[i++]], bth[buf[i++]], '-',
        bth[buf[i++]], bth[buf[i++]], '-',
        bth[buf[i++]], bth[buf[i++]], '-',
        bth[buf[i++]], bth[buf[i++]], '-',
        bth[buf[i++]], bth[buf[i++]],
        bth[buf[i++]], bth[buf[i++]],
        bth[buf[i++]], bth[buf[i++]]]).join('');
    }

    return curriculum;
})(curriculum || {});
if (typeof module != 'undefined') {
    module.exports = curriculum;
}
