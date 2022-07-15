import tap from 'tap'
import Curriculum from '../src/curriculum.js'

const curr = new Curriculum()

tap.test('loadContextFromFile', async t => {
	let context = await curr.loadContextFromFile('c', 'test/dummy-context/context.json')
	t.hasProp(curr.data, 'doel')
	t.hasProp(curr.data, 'niveau')
	t.equal(curr.data.doel.length, 2)
	t.equal(curr.data.niveau.length, 2)
	let doelId = curr.data.doel[0].id
	let niveauId = curr.data.doel[0].niveau_id[0]
	t.same(curr.index.references[niveauId], [doelId])
	t.end()
})

tap.test('validate', async t => {
	try {
		let result = await curr.validate()
		t.equal(result, true)
	} catch(error) {
		t.equal(error, false)
		Object.keys(error.validationErrors).forEach(schema => {
			error.validationErrors[schema].forEach(error => {
				console.log(error.instancePath+': '+error.message)
			})
		})
	}
	t.end()
})

tap.test('validateStrict', async t => {
	try {
		let result = await curr.validate(null, true)
		t.equal(result, true)
	} catch(error) {
		t.equal(error, false)
		Object.keys(error.validationErrors).forEach(schema => {
			error.validationErrors[schema].forEach(error => {
				console.log(error.instancePath+': '+error.message)
			})
		})
	}
	t.end()
})

tap.test('add', t => {
	let clone = curr.clone(curr.data.niveau[0])
	clone.id = curr.uuid()
	curr.add('c', 'niveau', clone)
	t.hasProp(clone, 'unreleased')
	t.hasProp(curr.index.id, clone.id)
	t.end()
})

tap.test('replace', t => {
	let niveau = curr.data.niveau[0]
	let clone = curr.data.niveau[2]
	let doelId = curr.index.references[niveau.id][0]
	let doel = curr.index.id[doelId]
	curr.replace(niveau.id, clone.id)
	t.hasProp(niveau, 'replacedBy')
	t.hasProp(clone, 'replaces')
	t.same(clone.replaces[0], niveau.id)
	t.same(niveau.replacedBy[0], clone.id)
	t.same(doel.niveau_id[0], clone.id)
	t.hasProp(doel, 'dirty')
	t.end()
})