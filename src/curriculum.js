import jsondiffpatch from 'jsondiffpatch'
import { v4 } from 'uuid'
import $RefParser from "json-schema-ref-parser"
import _ from 'lodash'
import { Octokit } from "@octokit/rest"
import Ajv from 'ajv'
import fetch from 'cross-fetch'
import { promises as fs } from 'fs'

if (!atob) {
    var atob = (base64) => {
        return Buffer.from(base64, 'base64').toString('binary');
    };
}

function dirname(path)
{
    if (path[path.length-1] == '/') {
        path = path.substring(0, path.length-1)
    }
    let slash = path.lastIndexOf('/')
    if (slash) {
        path = path.substring(0, slash)
    } else {
        path = '/'
    }
    return path
}

export default class Curriculum {

    constructor()
    {
        /**
         * Keeps track of the source of all schemas (file, github, url, etc)
         */
        this.sources = {}

        /**
         * Contains entities by type
         */
        this.data    = {}

        /**
         * List of errors found with loadData()
         */
        this.errors  = []

        this.index   = {
            /**
             * All non-deprecated entities by id
             */
            id: {},

            /**
             * Type by id
             */
            type: {},

            /**
             * Schema by id
             */
            schema: {},

            /**
             * References to other entities by id
             */
            references: {},

            /**
             * Deprecated entities by id
             */
            deprecated: {}
        }

        /**
         * An list of all the schemas as json, by name
         */
        this.schemas = {}

        /**
         * The schema data by schema name
         */
        this.schema  = {}
    }

    envIsNode()
    {
        var isNode = new Function("try { return this===global; } catch(e) { return false; }")
        return isNode();        
    }

    uuid()
    {
        return v4()
    }

    updateReferences(object)
    {
        Object.keys(object).forEach(k => {
            if (
                Array.isArray(object[k]) 
                && k.substr(k.length-3)=='_id'
            ) {
                object[k].forEach(id => {
                    if (!this.index.references[id]) {
                        this.index.references[id] = [];
                    }
                    this.index.references[id].push(object.id);
                })
            } else if (
                k.substr(k.length-3)=='_id'
                && typeof object[k]=='string'
            ) {
                var id = object[k]
                if (!this.index.references[id]) {
                    this.index.references[id] = []
                }
                this.index.references[id].push(object.id)
            }
        })
    }

    validate()
    {
        const ajv = new Ajv({
            'extendRefs': true,
            'allErrors': true,
            'jsonPointers': true
        })
        ajv.addKeyword('itemTypeReference', {
            validate: (schema, data, parentSchema, dataPath, parentData, propertyName, rootData) => {
                var matches = /.*\#\/definitions\/(.*)/g.exec(schema);
                if (matches) {
                    var result = this.index.type[data] == matches[1];
                    return result;
                }
                console.log('Unknown #ref definition: '+schema);
            }
        });
        const schemaBaseURL  = 'https://opendata.slo.nl/curriculum/schemas/';
        Object.keys(this.schemas).forEach(schemaName => {
            ajv.addSchema(this.schemas[schemaName], schemaBaseURL+schemaName+'/context.json')
        })
        var errors = {}
        var valid = true
        Object.keys(this.schemas).forEach(schemaName => {
            if (!ajv.validate(schemaBaseURL+schemaName+'/context.json', this.data)) {
                errors[schemaName] = ajv.errors
                valid = false
            }
        })
        if (!valid) {
            return errors
        } else {
            return true
        }
    }

    add(schemaName, section, object) 
    {
        if (!object.id) {
            object.id = this.uuid()
        }
        if (section == 'deprecated') {
            throw new Error('You cannot add to deprecated, use the deprecate function instead')
        }
        object.unreleased = true
        this.data[section].push(object)
        this.schema[schemaName][section].push(object)
        this.index.id[object.id] = object
        this.index.type[object.id] = section
        this.index.schema[object.id] = schemaName
        this.updateReferences(object)
        return object.id
    }

    deprecate(entity, replacedBy)
    {
        var currentSection = this.index.type[entity.id]
        if (!currentSection) {
            throw new Error('entity '+entity.id+' is not part of any schema')
        }

        this.replace(entity.id, replacedBy)
    }

    update(section, id, diff)
    {
        if (section == 'deprecated') {
            throw new Error('You cannot update deprecated entities')
        }
        var entity = this.index.id[id]
        var clone  = this.clone(entity)
        jsondiffpatch.patch(clone, diff)
        // check if entity must be deprecated
        // if so check that clone.id is not entity.id
        // if so create a new id for clone
        if (
            typeof entity.unreleased == 'undefined' 
            || !entity.unreleased
        ) {
            if (section=='deprecated') {
                // updating a deprecated entity, so only the replacedBy may be updated
                if (
                    Object.keys(diff).length>1 
                    || typeof diff.replacedBy == 'undefined'
                ) {
                    throw new Error('illegal deprecated entity update '+id+': '+JSON.stringify(diff))
                }
            }
            if (clone.id == entity.id) {
                clone.id = this.uuid()
            }
            this.add(section, clone)
            this.replace(entity.id, clone.id)
        } else {
            // no need to deprecate entity, just update its contents
            if (clone.id!=entity.id) {
                throw new Error('update cannot change entity id')
            }
            entity = jsondiffpatch.patch(entity, diff)
        }
        this.updateReferences(entity)
        return entity.id
    }

    /**
     * Replace an entity with a new entity
     * Find all links to the old entity and replace the links
     * add replacedBy in old entity
     * add replaces in new entity
     */
    replace(id, newId) 
    {
        var oldObject = this.index.id[id]
        var section   = this.index.type[id]
        if (section == 'deprecated') {
            throw new Error('refusing to replace '+id+' that is already deprecated');
        }
        var schemaName = this.index.schema[id]
        if (!Array.isArray(this.schema[schemaName][section])) {
            throw new Error(section+' is not part of schema '+schemaName)
        }
        if (newId) {
            var newObject  = this.index.id[newId]
        }
        if (!oldObject) {
            throw new Error('Could not find entity with id '+id+' to replace')
        }

        // if oldObject was released, deprecate it and set replaces/replacedBy references
        if (!oldObject.unreleased) {
            if (newObject) {
                if (!newObject.replaces) {
                    newObject.replaces = []
                }
                newObject.replaces.push(id)
            }
            if (!oldObject.replacedBy) {
                oldObject.replacedBy = []
            }
            if (newId) {
                oldObject.replacedBy.push(newId)
            }
        }
        
        if (!oldObject.types) {
            oldObject.types = []
        }
        oldObject.types.push(section)
        oldObject.types = [...new Set(oldObject.types)]

        // remove oldObject from current section
        this.data[section] = this.data[section].filter(e => e.id != oldObject.id)

        this.schema[schemaName][section] = this.schema[schemaName][section].filter(e => e.id != oldObject.id)

        var prop = this.index.type[oldObject.id]+'_id'; // get it here, since the next code might change it to deprecated

        if (!oldObject.unreleased) {
            // add oldObject to deprecated list
            if (this.index.type[oldObject.id]!='deprecated') {
                this.data.deprecated.push(oldObject)
                if (!this.schema[schemaName].deprecated) {
                    throw new Error('schema '+schemaName+' missing deprecated')
                }
                if (!Array.isArray(this.schema[schemaName].deprecated)) {
                    throw new Error('schema '+schemaName+' deprecated is not an array')
                }
                this.schema[schemaName].deprecated.push(oldObject)
                this.index.type[oldObject.id] = 'deprecated'
            }
        }

        // update all references to oldObject.id to newId
        var refs = this.index.references[oldObject.id]; // does not and must not include replaces/replacedBy references
        if (refs) {
            refs.forEach(id => {
                var refOb = this.index.id[id];
                if (refOb.deleted || this.index.type[refOb.id]==='deprecated') {
                    return; // this is/will be deprecated anyway, so changes here won't have any effect
                }
                if (!refOb.unreleased) {
                    // unreleased entities don't need to change their id if properties change
                    // so only mark released entities as dirty
                    refOb.dirty = true;
                }
                if (Array.isArray(refOb[prop])) {
                    if (newId) {
                        refOb[prop] = refOb[prop].map(refId => {
                            if (refId===oldObject.id) {
                                return newId;
                            }
                            return refId;
                        });
                    } else {
                        refOb[prop] = refOb[prop].filter(refId => refId!==oldObject.id);
                    }
                } else if (typeof refOb[prop]==='string' || refOb[prop] instanceof String) {
                    if (newId) {
                        refOb[prop] = newId;
                    } else {
                        delete refOb[prop];
                    }
                } else {
                    throw new Error('Unexpected property type for '+prop+' ( '+(typeof refOb[prop])+') '+refOb.id);
                }
            });
        }
    }

    getParentSections(section) 
    {
        var parentSections = []
        var parentProperty = this.getParentProperty(section)
        Object.values(this.schemas).forEach(schema => {
            Object.keys(schema.definitions).forEach(
                schemaSection => {
                    if (typeof schema.definitions[schemaSection].properties != 'undefined' 
                        && typeof schema.definitions[schemaSection].properties[parentProperty] != 'undefined'
                        && schemaSection != 'deprecated'
                    ) {
                        parentSections.push(schemaSection);
                    }
                }
            )
        });
        return parentSections;
    }

    getParentProperty(section) 
    {
        return section+'_id'
    }

    parseSchema(schema)
    {
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


    async loadData(schemaName) {

        const schema = this.schemas[schemaName];
        let data     = {};

        const properties = Object.keys(schema.properties);
        if (!properties || !properties.length) {
            console.warning('No properties defined in context '+schemaName)
            return data;
        }

        properties.forEach(propertyName => {
            if (typeof(schema.properties[propertyName]['#file']) != 'undefined') {
                data[propertyName] = (async () => {
                    switch(this.sources[schemaName].method) {
                        case 'url':
                            var baseURL = dirname(this.sources[schemaName].source)+'/'
                            return fetch(baseURL + schema.properties[propertyName]['#file'])
                            .then(response => {
                                if (response.ok) {
                                    return response.json();
                                }
                                throw new NetworkError(response.status+': '+response.statusText, { cause: response })
                            });
                        break;
                        case 'file':
                            var baseDir = dirname(this.sources[schemaName].source)+'/'
                            if (!this.envIsNode()) {
                                throw new Error('Filesystem support is limited to node-js')
                            }
                            let json = await fs.readFile(
                                baseDir + schema.properties[propertyName]['#file'], 
                                'utf8', 
                                (err, data) => {
                                    if (err) {
                                        reject(err)
                                    } else {
                                        resolve(data)
                                    }
                                }
                            )
                            return JSON.parse(json)
                        break;
                        case 'github':
                            return this.sources[schemaName]
                            	.getFile(schema.properties[propertyName]['#file'])
                            	.then(data => JSON.parse(data))
                        break;
                        default:
                            throw new Error('Unknown loading method '+this.sources[schemaName].method);
                        break;
                    }
                })()
            } else {
                data[propertyName] = []
                console.warning('No entities defined for '+propertyName)
            }
        })

        return Promise.allSettled(Object.values(data))
        .then(results => {
            Object.keys(data).forEach(propertyName => {
                data[propertyName].then(entities => {
                    console.log('index size '+Object.keys(this.index.id).length);
                    console.log('indexing '+schemaName+'.'+propertyName+' ('+entities.length+')');
                    if (!this.data[propertyName]) {
                        this.data[propertyName] = [];
                    }
                    Array.prototype.push.apply(this.data[propertyName],entities);

                    if (!this.schema[schemaName]) {
                        this.schema[schemaName] = {};
                    }
                    if (!this.schema[schemaName][propertyName]) {
                        this.schema[schemaName][propertyName] = [];
                    }
                    Array.prototype.push.apply(this.schema[schemaName][propertyName],entities);

                    var count = 0;
                    entities.forEach(entity => {
                        if (entity.id) {
                            if (this.index.id[entity.id]) {
                                this.errors.push('Duplicate id in '+schemaName+'.'+propertyName+': '+entity.id)
                            } else {
                                this.index.id[entity.id]     = entity
                                this.index.type[entity.id]   = propertyName
                                this.index.schema[entity.id] = schemaName
                                this.updateReferences(entity)
                                if (/deprecated/.exec(propertyName)!==null) {
                                    this.index.deprecated[entity.id] = entity;
                                }
                            }
                        } else {
                            this.errors.push('Missing id in '+schemaName+'.'+propertyName+': '+count)
                        }
                        count++
                    })
                })
            })
            return data
        })
    }

    async loadContextFromFile(schemaName, fileName)
    {
        this.sources[schemaName] = {
            method: 'file',
            source: fileName,
            state: 'loading'
        }
        const context = await fs.readFile(fileName, 'utf8')
        let schema = {}
        try {
            schema  = JSON.parse(context)
        } catch(error) {
            throw new SyntaxError('JSON Parse error in '+schemaName, { cause: error })
        }

        this.schemas[schemaName] = schema
        this.schema[schemaName] = {}
        await this.loadData(schemaName)
        this.sources[schemaName].state = 'available'
        return schema
    }

    async loadContextFromURL(schemaName, url)
    {
        this.sources[schemaName] = {
            method: 'url',
            source: url,
            state: 'loading'
        };
        const context = await fetch(url)
        try {
            const schema = JSON.parse(context)
        } catch(error) {
            throw new SyntaxError('JSON Parse error in '+schemaName, { cause: error })
        }

        this.schemas[schemaName] = schema
        this.schema[schemaName] = {}
        await this.loadData(schemaName)
        this.sources[schemaName].state = 'available'
        return schema
    };

    async loadContextFromGithub(schemaName, repository, owner, branchName, authToken=null)
    {

        if (!branchName) {
            branchName = 'master';
        }
        this.sources[schemaName] = {
            method: 'github',
            source: repository,
            branch: branchName,
            state: 'loading'
        };
        let options = {}
        if (authToken) {
        	options.auth = authToken
        }
        const octokit = new Octokit(options)
        var getFile = function(filename, list) {
            const nodes = filename.split('/');
            let node    = nodes.shift();
            let entry   = list.data.tree.filter(function(file) {
                return file.path == node;
            }).pop();
            let hash = entry.sha;
            if (nodes.length) {
                return octokit.rest.git
                    .getTree({owner:owner, repo:repository, tree_sha:hash})
                    .then(list => getFile(nodes.join('/'), list))
                
            } else {
                return octokit.rest.git
                    .getBlob({owner:owner, repo:repository, file_sha:hash})
                    .then(data => data.data)
                    .then(data => atob(data.content))
            }
        };
        this.sources[schemaName].repository = repository;
        this.sources[schemaName].getFile = async function(filename) {
            let branch     = await octokit.rest.repos.getBranch({owner:owner, repo:repository, branch:branchName})
            let lastCommit = branch.data.commit.sha
            let tree       = await octokit.rest.git.getTree({owner:owner, repo:repository, tree_sha:lastCommit})
            return getFile(filename, tree)
        };

        const context = await this.sources[schemaName].getFile('context.json')
        var schema = '';
       	try {
       		schema = JSON.parse(context);
       	} catch(e) {
       		console.error('Incorrect json: ', context)
       		throw new SyntaxError('Incorrect JSON in '+schemaName+' context.json')
        }

        this.schemas[schemaName] = schema
        this.schema[schemaName] = {}
        await this.loadData(schemaName)
        this.sources[schemaName].state = 'available'
        return schema
    }


    exportFiles(schema, schemaName, dir='')
    {
        const properties = Object.keys(schema.properties);
        
        properties.forEach(function(propertyName) {
            //FIXME: check this.sources.type
            if (typeof schema.properties[propertyName]['#file'] != 'undefined') {
                var file = schema.properties[propertyName]['#file']
                var fileData = JSON.stringify(this.schema[schemaName][propertyName], null, "\t")
                if (!fs.existsSync(dir+'data/')) {
                    fs.mkdirSync(dir+'data/', { recursive: true})
                }
                fs.writeFileSync(dir+file, fileData);
            } else {
                console.warning('skipping export of '+propertyName+' - no source file defined')
            }
        })
    }

    clone(object)
    {
        return JSON.parse(JSON.stringify(object))
    }

    getDirty()
    {
        let dirty = []
        Object.keys(this.index.id).forEach(id => {
            if (
                this.index.id[id].dirty 
                && !this.index.id[id].unreleased
            ) {
                dirty.push(this.index.id[id])
            }
        })
        return dirty
    }

    parseSchema(schema) {
        var resolveAllOf = (() => {
            // from https://github.com/mokkabonna/json-schema-merge-allof
            var customizer = function (objValue, srcValue) {
                if (Array.isArray(objValue)) {
                    return _.union(objValue, srcValue);
                }
                return;
            };
            return (inputSpec) => {
                if (inputSpec && typeof inputSpec === 'object') {
                    if (Object.keys(inputSpec).length > 0) {
                        if (inputSpec.allOf) {
                            var allOf  = inputSpec.allOf
                            delete inputSpec.allOf
                            var nested = _.mergeWith.apply(_, [{}].concat(allOf, [customizer]))
                            inputSpec  = _.defaultsDeep(inputSpec, nested, customizer)
                        }
                        Object.keys(inputSpec).forEach(function (key) {
                            inputSpec[key] = resolveAllOf(inputSpec[key])
                        })
                    }
                }
                return inputSpec
            }
        })()

        return $RefParser.dereference(schema)
        .then(function(schema) {
            return resolveAllOf(schema)
        })
    }

}    