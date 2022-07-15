# Curriculum-JS: browser and node-based library to work with slonl/curriculum-{context} data.

This library automates common tasks when manipulating data from the slonl/curriculum datasets.
You can find these datasets on github at https://github.com/slonl/

## Install

### Node

```
npm install curriculum-js
```

Then import it in your code like this:

```
import Curriculum from 'curriculum-js'
```

### Browser

```
npm install curriculum-js
```

Then either include the library directly in the HTML:

```
<script src="/node_modules/curriculum-js/dist/browser.js">
```

Or use import and a bundler:

```
import Curriculum from 'curriculum-js'
```

## Usage

The basic use case is to load raw curriculum data directly, instead of using the REST api at https://opendata.slo.nl/curriculum/

Loading the data from file, e.g. when you've checked out the curriculum data locally:

```javascript
import Curriculum from 'curriculum-js'

let myCurriculum = new Curriculum()
let schema = 'basis'

myCurriculum.loadContextFromFile(
    'curriculum-'+schema, 
    './curriculum-'+schema+'/context.json'
)
.then(() => {
	// do something with myCurriculum.data
})
```

Another use case is to validate the data in the curriculum context, e.g. when you've made changes to it.

```javascript
import Curriculum from 'curriculum-js'

async function validate() 
{
	var curriculum   = new Curriculum()
	var schema       = await curriculum.loadContextFromFile('curriculum-syllabus', 'context.json');
	var examenSchema = await curriculum.loadContextFromFile('curriculum-examenprogramma', 'curriculum-examenprogramma/context.json');
	try {
		let result = await curriculum.validate(schema)
		console.log('Data is valid!')
	} catch(error) {
		error.validationErrors.forEach(error => {
			console.log(error.instancePath+': '+error.message)
		})
	}
}

validate()
```

## About the curriculum context data structures

The curriculum context data uses a few novel ideas, that you must understand to understand how to use this library.

### Immutability (mostly)

The first idea is that all data is (mostly) immutable. So any entity that has been released is guaranteed to stay the same in any later release. Released entities will not change in the future, nor will they be deleted. This means that all references to other entities will stay the same, as well as all other properties, like title, prefix, etc.

### Updating Immutable Data

So the normal next question is, how can the data be updated, if it is immutable?

While we can't change existing entities, we can create new entities. And we can mark entities as deprecated.

So when a `ldkKern` needs to change, for example, we just create a new `ldkKern`, with the change. And then we look for references to the old entity, in this case in a `ldkVakleergebied`, and create a new entity for that as well, with the reference to the old `ldkKern` replaced with the new one.

In effect we now have two trees, the old one, with the old `ldkVakleergebied` as its root, and the new one, with the new `ldkVakleergebied` as its root.

![An immutable tree](/immutable-tree.png)

Since we also add `replacedBy` and `replaces` properties in the old and new entities, respectively, this allows us to time-travel through the dataset.

In practice we've found that this will generate too many new entities, if this is done for any change. So we've optimized it a bit. Instead of doing this for any change, we only do this when we release a new dataset. Before that we simply mark each changed entity as `dirty`, but only if the entity has been released. Any new entity starts its life with an `unreleased: true` property. This is removed in the release procedure.

There release procedure handles the deprecation of dirty entities, creating new id's for the changed entities and setting the `replacedBy` and `replaces` properties.

An entity that is deprecated, is moved to the `deprecated` section of the data. Its original type (root property that contained it) is stored in `entity.types`.

You will only ever see unreleased or dirty entities, if you use the pre-release datasets, which can be found in the `editor` branch of each curriculum context on github.

### A Forest of Directed Acyclic Graphs

All entities together form a set (or forest) of DAGs. This means that if you take a root entity of some context, e.g. a `ldkVakleergebied`, you can recurse over its properties to find all child entities and be guaranteed that the recursion will end. There are no cycles in the references. There can be many root entities for each context.

### Linked Data

The datasets link to each other, using the UUID's. But the actual ID's of each entity, as released through the REST API (https://opendata.slo.nl/curriculum/), use an @id URL and JSON-LD. The information needed to do this transformation is provided in the `schema.jsonld` file in each context.

## Reference

## (object) curriculum.data

This contains all the data from all loaded contexts. Each context is defined by its JSON-Schema, in the `context.json` file. This schema contains a list of all properties exposed by this context. Each property is loaded as a property in `curriculum.data`. E.g. `curriculum.data.niveau`.

## (object) curriculum.sources

This contains a list of source information, per loaded schema. It is used by `curriculum.loadData`, so it can load the data relative to the source of the original `context.json` schema.

## (array) curriculum.errors

If `curriculum.loadData` encounters any errors, they will be listed here.

## (object) curriculum.index.id

Contains an index of all loaded non-deprecated entities, by their UUID. E.g.:

```javascript
let entity = curriculum.index.id['6ed6fb6f-5cd5-40d1-945d-1f02af6a79da']
```

If you want to iterate over all entities (that aren't deprecated), do:

```javascript
Ojbect.values(curriculum.index.id).forEach(entity => {
	// do something with each entity
})
```

## (object) curriculum.index.type

This is a reference with the property name of each non-deprecated entity. e.g.

```javascript
let mytype = curriculum.index.type['6ed6fb6f-5cd5-40d1-945d-1f02af6a79da']
// results in 'vakleergebied' (in the 2021 dataset)
```

## (object) curriculum.index.schema

Contains the schema associated with each entity.

## (object) curriculum.index.references

Curriculum entities reference other entities through their own properties. This index allows you to do the reverse, find the "parent" entities that refer to a given entity id, e.g.:

```javascript
let references = curriculum.index.references['6ed6fb6f-5cd5-40d1-945d-1f02af6a79da']
if (references) {
	references.forEach(refId => {
		let parent = curriculum.index.id[refId]
		// and now do something with it
	})
}
```

## (object) curriculum.index.deprecated

Contains a list of all entities that are deprecated, similar to `curriculum.index.id`. To find out which type the deprecated entity is (or was), use the `entity.types` array. This is an array because of historical reasons. Data after the original core set (pre-2019) should have just one value here. This contains the property name or type of the entity, before it was deprecated.

## (object) curriculum.schemas

This is a list of all the JSON Schemas, by schema name.

## (object) curriculum.schema

This contains all the properties and entities loaded from this schema, by schema name, e.g:

```javascript
let niveaus = curriculum.schema['curriculum-basis'].niveau;
```

Usually there is no need to specifically reference a single schema. The exception is for deprecated entities. Each schema has its own deprecated list, but all deprecated items are loaded into `curriculum.data.deprecated`. Using the `curriculum.schema` reference, you can find out where a deprecated item originated.


## Promise (object) curriculum.loadContextFromFile(schemaName, fileName)

This loads a curriculum context from file. The schemaName is a string that will be used to identify this schema in the rest of your code, you may enter any value here. The fileName is the fileName of the `context.json` JSON Schema file. It must contain a `properties` object, with a `#file` entry for each property. 
It will return a promise, which resolves with the loaded and parsed JSON Schema.

```javascript
loadContextFromFile('mySchema', './curriculum-basis/context.json')
.then(schema => {
	// data is now loaded in curriculum.data
})
```

## Promise (object) curriculum.loadContextFromURL(schemaName, url)

This loads a curriculum context from a URL. The schemaName is a string that will be used to identify this schema in the rest of your code, you may enter any value here. The url is the url of the `context.json` JSON Schema file. It must contain a `properties` object, with a `#file` entry for each property. The data files must be available with this filename, relative to the url of the `context.json` file.
It will return a promise, which resolves with the loaded and parsed JSON Schema.

```javascript
loadContextFromURL('mySchema', 'https://example.com/curriculum-basis/context.json')
.then(schema => {
	// data is now loaded in curriculum.data
})
```

## Promise (object) curriculum.loadContextFromGithub(schemaName, repository, owner, branchName='master', authToken=null)

This loads a curriculum context from a github repository. The schemaName is a string that will be used to identify this schema in the rest of your code, you may enter any value here. You must supply the repository and owner, e.g. 'curriculum-basis' and 'slonl'. If no branchName is supplied it will use the master branch. The authToken is a personal access token, as supplied by Github.
It will return a promise, which resolves with the loaded and parsed JSON Schema.

```javascript
loadContextFromGithub('mySchema', 'curriculum-basis', 'slonl', 'master', myToken)
.then(schema => {
	// data is now loaded in curriculum.data
})
```

## (void) curriculum.loadContext(schema, data)

This method allows you write your own `loadContextFromSomething()` method. When the schema and data are both loaded, just call this method to index the data and make it available under `curriculum.data`. The schema must be a JSON Schema object (not a json string or filename). The data must contain all the properties referenced in the JSON Schema.

## Promise (bool) curriculum.validate(schema=null)

This method validates the loaded data against either a given schema, or if no schema is passed, it will validate all loaded data against the schema with which they were loaded. It will return a Promise that resolves to true, if no errors were found. If errors are found, it will throw a ValidationError with all errors found, per schema.

## (string) curriculum.add(schemaName, type, object)

Adds a new entity to a given curriculum context (by schemaName) and type (root property of the context.)
*note*: you cannot add an object to the deprecated section, use the deprecate() method instead. This method will also update relevant indexes.
It will return the newly generated object id, if no `object.id` value was set.

## (string) curriculum.replace(oldId, newId=null)

Replaces an entity with a new entity. The entities must both already exist. The old entity must not be deprecated already.
This method will find all references to the oldId and replace it with newId. If no newId is given, it will just remove the references.
It will only do this for non-deprecated objects, so all deprecated objects with a reference to oldId will keep this reference.
Any object where a reference is modified and which has been released (it has no property `unreleased`) will get marked dirty (it gains the property `dirty:true`)
All indexes will be updated. The oldId is deprecated and gains a `replacedBy:[newId]` reference. The new object gains a `replaces:[oldId]` reference.

## (object) curriculum.clone(object)

A utility function to deep-clone objects. This is used by curriculum.replace, among others.

## (string) curriculum.uuid()

Creates a new random UUID (v4).

## (string) curriculum.getSchemaFromType(type)

This returns the JSON Schema in which {type} was defined.

## curriculum.treewalk(node, options, parent=null)

Walks over a curriculum graph, running one or both a topdown/bottomup function on each entity

Parameters:
- (object) node: The root node to start with
- (object) options: See the options section below
- (object) parent The parent node of this node, if available

Options can be:
- (function) topdownCallback a function that is called on each node, before calling it on the child nodes
- (function) bottomupCallback a function that is called on each child node before calling it on the parent node
- (array) terminalTypes a list of types that stop the treewalk from calling on child nodes
- (array) limitSchemas a list of schemas, if a node is not part of this set of schemas, it will not be called
