import { indexOfMax } from '../math/VectorMath.js'
import { wordCharacterPattern } from '../nlp/Segmentation.js'
import Onnx from 'onnxruntime-node'
import { Logger } from '../utilities/Logger.js'
import { logToStderr } from '../utilities/Utilities.js'
import { Timeline } from '../utilities/Timeline.js'
import { RawAudio, getRawAudioDuration } from '../audio/AudioUtilities.js'
import { readAndParseJsonFile, readFile } from '../utilities/FileSystem.js'
import path from 'path'

const log = logToStderr

export async function recognize(rawAudio: RawAudio, modelDirectory: string) {
	const logger = new Logger()
	logger.start('Create ONNX inference session')

	const modelPath = path.join(modelDirectory, 'model.onnx')
	const labelsPath = path.join(modelDirectory, 'labels.json')

	const labels: string[] = await readAndParseJsonFile(labelsPath)

	const onnxOptions: Onnx.InferenceSession.SessionOptions = {
		logSeverityLevel: 3
	}

	const recognition = await Onnx.InferenceSession.create(modelPath, onnxOptions)

	logger.start('Prepare input data')

	const audioSamples = rawAudio.audioChannels[0]

	const inputTensor = new Onnx.Tensor('float32', audioSamples, [1, audioSamples.length])

	const inputs = { input: inputTensor }

	logger.start('Recognize with silero model')

	const results = await recognition.run(inputs)

	const rawResultValues = results['output'].data as Float32Array

	const tokenResults: Float32Array[] = []

	for (let i = 0; i < rawResultValues.length; i += labels.length) {
		tokenResults.push(rawResultValues.subarray(i, i + labels.length))
	}

	const tokens: string[] = []

	for (const tokenResult of tokenResults) {
		const bestCandidateIndex = indexOfMax(new Array(...tokenResult))
		tokens.push(labels[bestCandidateIndex])
	}

	//log(tokens.join('|'))

	const result = processTokens(tokens, getRawAudioDuration(rawAudio))

	logger.end()

	return result
}

function processTokens(tokens: string[], totalDuration: number) {
	const tokenCount = tokens.length

	const decodedTokens: string[] = []
	let tokenGroupIndexes: number[][] = [[]]

	for (let i = 0; i < tokenCount; i++) {
		const token = tokens[i]

		if (token == '2') {
			if (decodedTokens.length > 0) {
				const previousDecodedToken = decodedTokens[decodedTokens.length - 1]
				decodedTokens.push('$')
				decodedTokens.push(previousDecodedToken)

				tokenGroupIndexes[tokenGroupIndexes.length - 1].push(i)
			} else {
				decodedTokens.push(' ')
				tokenGroupIndexes.push([])
			}

			continue
		}

		if (token == '_') {
			continue
		}

		decodedTokens.push(token)

		if (token == ' ') {
			tokenGroupIndexes.push([])
		} else {
			tokenGroupIndexes[tokenGroupIndexes.length - 1].push(i)
		}
	}

	let decodedString = ''

	for (let i = 0; i < decodedTokens.length; i++) {
		const currentToken = decodedTokens[i]
		const previousToken = decodedTokens[i - 1]

		if (currentToken != '$' && (previousToken != currentToken || previousToken == undefined)) {
			decodedString += currentToken
		}
	}

	decodedString = decodedString.trim()

	tokenGroupIndexes = tokenGroupIndexes.filter(group => group.length > 0)

	if (tokenGroupIndexes.length > 0) {
		let currentCorrection = Math.min(tokenGroupIndexes[0][0], 1.5)

		for (let i = 0; i < tokenGroupIndexes.length; i++) {
			const group = tokenGroupIndexes[i]

			if (group.length == 1) {
				group.push(group[0])
			}

			group[0] -= currentCorrection

			if (i == tokenGroupIndexes.length - 1) {
				currentCorrection = Math.min(tokenCount - i, 1.5)
			} else {
				currentCorrection = Math.min((tokenGroupIndexes[i + 1][0] - group[group.length - 1]) / 2, 1.5)
			}

			group[group.length - 1] += currentCorrection
		}
	}

	const words = decodedString.split(' ')

	const timeMultiplier = totalDuration / tokenCount

	const timeline: Timeline = []

	for (let i = 0; i < words.length; i++) {
		const text = words[i]

		if (!wordCharacterPattern.test(text)) {
			continue
		}

		const group = tokenGroupIndexes[i]
		const startTime = group[0] * timeMultiplier
		const endTime = group[group.length - 1] * timeMultiplier

		timeline.push({
			type: 'word',
			text: text,
			startTime,
			endTime,
		})
	}

	timeline[timeline.length - 1].endTime = totalDuration

	return { transcript: decodedString, timeline }
}

export const languageCodeToPackageName: { [languageCode: string]: string } = {
	'en': 'silero-en-v5',
	'es': 'silero-es-v1',
	'de': 'silero-de-v1',
	'uk': 'silero-ua-v3',
}
