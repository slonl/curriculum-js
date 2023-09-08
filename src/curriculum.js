import jsondiffpatch from 'jsondiffpatch'
import { v4 } from 'uuid'
import $RefParser from "json-schema-ref-parser"
import _ from 'lodash'
import { Octokit } from "@octokit/rest"
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import fetch from 'cross-fetch'
import fs from 'fs'
import base64 from "base-64"
import utf8 from "utf8"

/**
 * Return the parent directory of a given path, without the last '/'
 * If there is no parent directory, return '.'
 * @param (string) path
 * @returns string
 */
function dirname(path)
{
    if (path[path.length-1] == '/') {
        path = path.substring(0, path.length-1)
    }
    let slash = path.lastIndexOf('/')
    if (slash) {
        path = path.substring(0, slash)
    } else {
        path = ''
    }
    if (!path) {
        path = '.'
    }
    return path
}


// For decoding base64 encoded data to readable UTF-8 formatted content
function dataDecoder(dataContent) {
  let decoded = base64.decode(dataContent);
  let result = utf8.decode(decoded);

  return result;
}

/**
 * The Curriculum class exposes a number of utility methods to manipulate the curriculum datasets
 * from github.com/slonl/curriculum-* repositories.
 *
 * Usage:
 *     let myCurriculum = new Curriculum()
 *     myCurriculum.loadContextFromGithub('curriculum-basis', 'curriculum-basis', 'slonl', 'master', authToken)
 *     .then(() => {
 *         // context is loaded in curriculum.data
 *     })
 */
export default class Curriculum
{
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

        /**
         * Allow access to Octokit
         */
        this.Octokit = Octokit
    }

    /**
     * Check if we are running inside Node
     * @returns boolean 
     */
    envIsNode()
    {
        var isNode = new Function("try { return this===global; } catch(e) { return false; }")
        return isNode();        
    }

    /**
     * Creates a new UUID v4 (random)
     * @returns string
     */
    uuid()
    {
        return v4()
    }

    /**
     * This updates the references index for a given object. Call this after you've added or removed 
     * entries in a object.{something}_id array.
     * @param object an entity from an slonl curriculum-context
     * @returns void
     */
    updateReferences(object)
    {
        if (this.index.type[object]==='deprecated') {
            return;
        }
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

    /**
     * This validates a loaded curriculum context against a JSON-Schema schema, 
     * or if no schema is given, it will validate all loaded curriculum contexts against their own context.json schema.
     * It will return a Promise(true) or throw a ValidationError.
     * If you validate all schema's, it will return the list of errors grouped by schema.
     * @param (optional) object Schema the JSON-Schema schema to validate
     * @param (optional) boolean strict if true, do not allow extra unspecified properties, default value is false
     * @return Promise (boolean) true if valid
     * @throws ValidationError if any errors are found
     */
    validate(schema=null, strict=false)
    {
        const ajv = new Ajv({
            'loadSchema': loadSchema,
            'allErrors': true,
            'strict': strict
        })
        async function loadSchema(uri) {
            const res = await fetch(uri)
            if (res.statusCode >= 400) {
                throw new Error('Error loading schema '+uri+': '+res.statusCode)
            }
            return res.json()
        }

        addFormats(ajv) // add format: "uuid" support, among others
        ajv.addKeyword({
            keyword: 'itemTypeReference',
            validate: (schema, data, parentSchema, dataPath, parentData, propertyName, rootData) => {
                var matches = /.*\#\/definitions\/(.*)/g.exec(schema);
                if (matches) {
                    var result = this.index.type[data] == matches[1];
                    return result;
                }
                console.log('Unknown #ref definition: '+schema);
            }
        });
        if (!schema) {
            // validate all schemas and data, fetching missing schemas from URL
            const schemaBaseURL  = 'https://opendata.slo.nl/curriculum/schemas/';
            Object.keys(this.schemas).forEach(schemaName => {
                ajv.addSchema(this.schemas[schemaName], schemaBaseURL+schemaName+'/context.json')
            })
            var errors = {}
            return Promise.allSettled(Object.keys(this.schemas).map(schemaName => {
                // for strict testing, we must remove the '#file' entries
                // since keywords with '#' in them are not allowed
                let schema = this.clone(this.schemas[schemaName])
                Object.keys(schema.properties).forEach(property => {
                    delete schema.properties[property]['#file']
                })

                return ajv.compileAsync(schema)
                .then((validate) => {
                    let valid = validate(this.data)
                    if (!valid) {
                        errors[schemaName] = vallidate.errors
                    }
                    return valid
                })
            }))
            .then(results => {
                if (results.indexOf(false)!==-1) {
                    if (!errors || !errors.length) {
                        errors = results;
                    }
                    throw new ValidationError('Invalid data found', errors)
                }
                return true
            })
        } else {
            // for strict testing, we must remove the '#file' entries
            // since keywords with '#' in them are not allowed
            schema = this.clone(schema)
            Object.keys(schema.properties).forEach(property => {
                delete schema.properties[property]['#file']
            })

            return ajv.compileAsync(schema)
            .then((validate) => {
                let valid = validate(this.data)
                if (!valid) {
                    errors = validate.errors
                    throw new ValidationError('Invalid data found', errors)
                }
                return valid
            })
        }
    }

    /**
     * Adds a new entity to a given curriculum context (by schemaName) and section (root property of the context)
     * *note*: you cannot add an object to the deprecated section, use the deprecate() method instead
     * @param (string) schemaName: the name of the schema, as used in the LoadContextFrom* methods
     * @param (string) section: the name of the root property in the schema to add the object to
     * @param (object) object: the new object to add
     */
    add(schemaName, section, object) 
    {
        if (!object.id) {
            object.id = this.uuid()
        }
        // FIXME: if object.id was set already, check that it isn't in use, if so throw an error
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

    /**
     * Deprecates an existing entity. It removes this object from its current list (root property).
     * It moves it to the deprecated list (context.deprecated property)
     * It replaces all links to it with the replacedBy parameter.
     * If no replacedBy is given, all links to it are deleted.
     * @param (object) entity: the curriculum entity to deprecate
     * @param (int) replacedBy: the id of the curriculum entity that replaces the deprecated object
     * @returns void
     */
    deprecate(entity, replacedBy)
    {
        var currentSection = this.index.type[entity.id]
        if (!currentSection) {
            throw new Error('entity '+entity.id+' is not part of any schema')
        }

        this.replace(entity.id, replacedBy)
    }


    /**
     * Replaces an entity id with a new entity id, deprecates the old id.
     * Finds all links to the old entity and replace the links
     * then adds replacedBy=>newId in the old entity and adds replaces=>id in the new entity
     * This method also updates relevant indexes.
     * *note* entities that are already deprecated cannot be replaced
     * @param (int) id: the id of the entity to replace
     * @param (int) newId: the id of the entity that replaces it
     * @throws Error when trying to replace a deprecated entity or an unknown entity
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
        // remove all references in index.references from oldObject.id
        var props = Object.keys(oldObject);
        props.forEach(prop => {
            if (prop.substring(prop.length-3)==='_id') {
                let list = oldObject[prop]
                if (!Array.isArray(list)) {
                    list = [list]
                }
                list.forEach(refId => {
                    if (this.index.references[refId]) {
                        this.index.references[refId] = this.index.references[refId].filter(
                            objectId => objectId!=oldObject.id 
                        )
                    }
                })
            }
        })

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
                        })
                        refOb[prop] = [ ...new Set(refOb[prop])] // filter double entries
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

    /**
     * This method is probably no longer needed, FIXME: check this
     */
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

    /**
     * This method is probably no longer needed, FIXME: check this
     */
    getParentProperty(section) 
    {
        return section+'_id'
    }

    /**
     * This parses a JSON-Schema schema and fills in all $ref references
     * @retuns (object) the filled in schema
     */
    async parseSchema(schema)
    {
        // from https://github.com/mokkabonna/json-schema-merge-allof

        const customizer = (objValue, srcValue) => {
            if (Array.isArray(objValue)) {
                return _.union(objValue, srcValue)
            }
            return
        }

        const resolveAllOf = (inputSpec) => {
            if (inputSpec && typeof inputSpec === 'object') {
                if (Object.keys(inputSpec).length > 0) {
                    if (inputSpec.allOf) {
                        const allOf  = inputSpec.allOf
                        delete inputSpec.allOf
                        const nested = _.mergeWith.apply(_, [{}].concat(allOf, [customizer]))
                        inputSpec    = _.defaultsDeep(inputSpec, nested, customizer)
                    }
                    Object.keys(inputSpec).forEach((key) => {
                        inputSpec[key] = resolveAllOf(inputSpec[key])
                    })
                }
            }
            return inputSpec
        }

        return resolveAllOf(await $RefParser.dereference(schema))
    }

    /**
     * This method loads the data from a schema by schemaName. The schema must
     * have been loaded first, and it must include the curriculum-specific #file properties
     * The schema can be loaded from file, url or github.
     * @param (string) schemaName: the name of the loaded schema, as passed to loadContextFrom* methods
     * @returns Promise
     * @throws NetworkError in case of a url-loaded schema encounters a network error loading the data
     * @throws Error in case of an unknown load method (not url, file or github)
     */
    async loadData(schemaName)
    {

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
                            let json = fs.readFileSync(
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

        let keys = Object.keys(data)
        return Promise.allSettled(Object.values(data))
        .then(results => {
            let values = {}
            Object.keys(results).forEach(key => {
                let name = keys[key]
                if (typeof results[key].value !== 'undefined') {
                    values[name] = results[key].value
                }
            })
            return values;
        })
        .then(data => {
            this.indexData(data, schemaName)
            return data
        })
    }

    /**
     * Indexes all data from a given schemaName. This is called automatically by loadData()
     * @param (object) data: the loaded data for the schema
     * @param (string) schemaName: the name of the schema
     * @returns void
     */
    indexData(data, schemaName) 
    {
        Object.keys(data).forEach(propertyName => {
            let entities = data[propertyName]
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
    }

    /**
     * Register the data for a given schema. Use this when the data is already loaded.
     * @param (object) schema: the JSON-Schema of the context
     * @param (object) data: the data for the context
     * @returns void
     */
    loadContext(schema, data)
    {
        let schemaName = schema['$id'] // check that it exists
        this.sources[schemaName] = {
            method: 'direct'
        }
        this.schemas[schemaName] = schema
        this.schema[schemaName]  = data
        this.indexData(data, schemaName)
    }

    /**
     * Loads a curriculum context from file.
     * @param (string) schemaName: the name of the schema
     * @param (string) fileName: the filename of the JSON-Schema file
     * @returns Promise( (object) schema)
     */
    async loadContextFromFile(schemaName, fileName)
    {
        if (!this.envIsNode()) {
            throw new Error('Filesystem support is limited to node-js')
        }
        this.sources[schemaName] = {
            method: 'file',
            source: fileName,
            state: 'loading'
        }
        const context = fs.readFileSync(fileName, 'utf8')
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

    /**
     * Loads a curriculum context from a URL.
     * @param (string) schemaName: the name of the schema
     * @param (string) url: the url of the JSON-Schema file
     * @returns Promise( (object) schema)
     */
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

    /**
     * Loads a curriculum context from github.
     * @param (string) schemaName: the name of the schema
     * @param (string) repository: the name of the repository, e.g. 'curriculum-basis'
     * @param (string) owner: the owner of the repository, e.g. 'slonl'
     * @param (optional) (string) branchName: the branch of the repository, e.g. 'master' (the default)
     * @param (optional) (string) authToken: the personal access token from github
     * @returns Promise( (object) schema)
     */
    async loadContextFromGithub(schemaName, repository, owner, branchName='master', authToken=null)
    {
        if (!branchName) {
            branchName = 'master';
        }
        this.sources[schemaName] = {
            method: 'github',
            owner: owner,
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
                  .then(data => dataDecoder(data.content))
            }
        };
        this.sources[schemaName].files = {}
        this.sources[schemaName].repository = repository
        this.sources[schemaName].getFile = async (filename) => {
            let branch     = await octokit.rest.repos.getBranch({
                owner:owner, 
                repo:repository, 
                branch:branchName
            })
            let lastCommit = branch.data.commit.sha
            let tree       = await octokit.rest.git.getTree({
                owner:owner, 
                repo:repository, 
                tree_sha:lastCommit
            })
            this.sources[schemaName].files[filename] = lastCommit
            return getFile(filename, tree)
        };
        this.sources[schemaName].writeFile = async (filename, content, message) => {
            let currentCommit = this.sources[schemaName].files[filename]
            await this.sources[schemaName].getFile(filename)
            let lastCommit = this.sources[schemaName].files[filename]
            if (lastCommit!=currentCommit) {
                throw new Error('file is not up to date: '+filename);
            }
            return octokit.rest.repos.createOrUpdateFileContents({
                owner: owner,
                repo: repository,
                path: filename,
                message: message,
                content: base64.encode(content)
            })
        }

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

    /**
     * Writes the data from curriculum.data to a set of files, as defined in the schema
     * @param (object) schema: the schema of the curriculum context to write the files for
     * @param (string) schemaName: the name of the schema
     * @param (string) dir: the directory to use for the schema
     * @returns void
     * @throws Error if this is run outside of Node, since filesystem support is limited to Node.
     */
    exportFiles(schema, schemaName, dir='')
    {
        if (!this.envIsNode()) {
            throw new Error('Filesystem support is limited to node-js')
        }
        const properties = Object.keys(schema.properties);

        properties.forEach(propertyName => {
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

    /**
     * Creates a deep copy of an object. The object must not have recursive references.
     */
    clone(object)
    {
        return JSON.parse(JSON.stringify(object))
    }

    /**
     * Returns a list of entities that have been marked dirty. Entities are marked
     * dirty either by hand or by the replace() method.
     * It will filter out all unreleased entities and all deprecated entities.
     * @returns (array) an array of dirty entities.
     */
    getDirty()
    {
        let dirty = []
        Object.keys(this.index.id).forEach(id => {
            if (
                this.index.id[id].dirty 
                && !this.index.id[id].unreleased
                && this.index.type[id]!=='deprecated'
            ) {
                dirty.push(this.index.id[id])
            }
        })
        return dirty
    }

    /**
     * Returns the JSON Schema where parameter type is defined
     * @param (string) type
     */
    getSchemaFromType(type)
    {
        return Object.keys(this.schemas).reduce((acc, schema) => {
            if (typeof this.schemas[schema].properties[type] != 'undefined') {
                return schema
            }
            return acc
        }, '')
    }

    /**
     * Walks over a curriculum graph, running one or both a topdown/bottomup function on each entity
     * @param (object) node The root node to start with
     * @param (object) options See the options section below
     * @param (object) parent The parent node of this node, if available
     *
     * Options can be:
     * - (function) topdownCallback a function that is called on each node, before calling it on the child nodes
     * - (function) bottomupCallback a function that is called on each child node before calling it on the parent node
     * - (array) terminalTypes a list of types that stop the treewalk from calling on child nodes
     * - (array) limitSchemas a list of schemas, if a node is not part of this set of schemas, it will not be called
     */
    treewalk(node, options, parent=null)
    {
        if (typeof options === 'function') {
            options = {
                topdownCallback: options
            }
        }
        let stop = false
        if (typeof options.topdownCallback === 'function') {
            stop = options.topdownCallback(node, parent)
        }
        if (!stop && Array.isArray(options.terminalTypes)) {
            stop = options.terminalTypes.includes(this.index.type[node.id])
        }
        if (!stop && node.children && Array.isArray(node.children)) {
            let children = node.children
            if (Array.isArray(options.limitSchemas)) {
                children = children.filter(id => options.limitSchemas.includes(this.index.schema[id]))
            }
            children.forEach(id => this.treewalk(this.index.id[id], options, node))
        }
        if (typeof options.bottomupCallback === 'function') {
            options.bottomupCallback(node, parent)
        }
    }
}

/**
 * Represents a validation error when running the Curriculum.validate() method.
 * It contains an extra property validationErrors, which you can use to see 
 * what the validation errors were, per schema.
 */
class ValidationError extends Error
{
    constructor(message, errors)
    {
        super(message)
        this.validationErrors = errors
    }
}
