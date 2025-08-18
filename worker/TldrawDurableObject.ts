import { RoomSnapshot, TLSocketRoom } from '@tldraw/sync-core'
import {
	TLRecord,
	createTLSchema,
	defaultBindingSchemas,
	defaultShapeSchemas,
} from '@tldraw/tlschema'
import { T } from '@tldraw/validate'
import { AutoRouter, IRequest, error } from 'itty-router'
import throttle from 'lodash.throttle'
import { CanvasToolHandler } from './CanvasToolHandler'

// Define Miyagi custom shapes schema for server validation
const miyagiWidgetShapeSchema = {
	props: {
		w: T.number,
		h: T.number,
		widgetId: T.string,
		templateId: T.string,
		htmlContent: T.string,
		color: T.string,
		miyagiStorage: T.optional(T.dict(T.string, T.string)), // Add miyagiStorage as optional dictionary
	},
	// migrations property is optional, can be omitted for simple shapes
}

// Univer shape schema for embedded spreadsheets/docs
const univerShapeSchema = {
	props: {
		w: T.number,
		h: T.number,
		univerType: T.literalEnum('sheets', 'docs', 'slides'),
		univerData: T.optional(T.any),
	},
}

// Block mode shapes
const widgetBlockShapeSchema = {
	props: {
		w: T.number,
		h: T.number,
		blockType: T.string,
		columnSpan: T.optional(T.number),
		content: T.optional(T.any),
		widgetId: T.string,
	},
}

const freeformBlockShapeSchema = {
	props: {
		w: T.number,
		h: T.number,
		blockType: T.string,
		columnSpan: T.optional(T.number),
		content: T.optional(T.any),
	},
}

// Create schema with custom shapes and default shapes
const schema = createTLSchema({
	shapes: { 
		...defaultShapeSchemas,
		'miyagi-widget': miyagiWidgetShapeSchema,
		'univer': univerShapeSchema,
		'widget-block': widgetBlockShapeSchema,
		'freeform-block': freeformBlockShapeSchema,
	},
	bindings: { ...defaultBindingSchemas },
})

// each whiteboard room is hosted in a DurableObject:
// https://developers.cloudflare.com/durable-objects/

// there's only ever one durable object instance per room. it keeps all the room state in memory and
// handles websocket connections. periodically, it persists the room state to the R2 bucket.
export class TldrawDurableObject {
	private r2: R2Bucket
	// TEMPORARILY DISABLED FOR TESTING
	// private miyagiApiUrl: string
	// the room ID will be missing while the room is being initialized
	private roomId: string | null = null
	// when we load the room from the R2 bucket, we keep it here. it's a promise so we only ever
	// load it once.
	private roomPromise: Promise<TLSocketRoom<TLRecord, void>> | null = null
	// Canvas tool handler for clean separation
	private canvasToolHandler: CanvasToolHandler

	constructor(
		private readonly ctx: DurableObjectState,
		env: Env
	) {
		this.r2 = env.TLDRAW_BUCKET
		// TEMPORARILY DISABLED FOR TESTING
		// this.miyagiApiUrl = env.MIYAGI_API_URL || 'http://localhost:3001'

		// Initialize canvas tool handler
		this.canvasToolHandler = new CanvasToolHandler(() => this.getRoom())

		ctx.blockConcurrencyWhile(async () => {
			this.roomId = ((await this.ctx.storage.get('roomId')) ?? null) as string | null
		})
	}

	private readonly router = AutoRouter({
		catch: (e) => {
			console.log(e)
			return error(e)
		},
	})
		// when we get a connection request, we stash the room id if needed and handle the connection
		.get('/api/connect/:roomId', async (request) => {
			if (!this.roomId) {
				await this.ctx.blockConcurrencyWhile(async () => {
					await this.ctx.storage.put('roomId', request.params.roomId)
					this.roomId = request.params.roomId
				})
			}
			return this.handleConnect(request)
		})

		// Canvas tool routes - each tool has its own route
		.get('/api/canvas/:roomId/get-pages', async (request) => {
			return this.canvasToolHandler.handleGetPages(request)
		})
		.get('/api/canvas/:roomId/get-widgets', async (request) => {
			return this.canvasToolHandler.handleGetWidgets(request)
		})
		.post('/api/canvas/:roomId/add-widget', async (request) => {
			return this.canvasToolHandler.handleAddWidget(request)
		})
		.put('/api/canvas/:roomId/edit-widget/:shapeId', async (request) => {
			return this.canvasToolHandler.handleEditWidgetHtml(request)
		})
		.put('/api/canvas/:roomId/update-storage/:shapeId', async (request) => {
			return this.canvasToolHandler.handleUpdateWidgetStorage(request)
		})
		.post('/api/canvas/:roomId/generate-widget', async (request) => {
			return this.canvasToolHandler.handleGenerateWidget(request)
		})

	// `fetch` is the entry point for all requests to the Durable Object
	fetch(request: Request): Response | Promise<Response> {
		return this.router.fetch(request)
	}

	// what happens when someone tries to connect to this room?
	async handleConnect(request: IRequest) {
		// extract query params from request
		const userId = request.query.userId as string
		if (!userId) return error(400, 'Missing userId')

		// TEMPORARILY DISABLED AUTH FOR TESTING
		// extract auth token from headers
		// const authToken = request.headers.get('authorization')
		// if (!authToken) return error(401, 'Missing authorization header')

		// validate the user session against Miyagi auth system
		// const authResult = await this.validateUserSession(authToken, this.roomId!, userId)
		// if (!authResult.valid) {
		// 	return error(401, 'Invalid session or insufficient permissions')
		// }

		// Create the websocket pair for the client
		const { 0: clientWebSocket, 1: serverWebSocket } = new WebSocketPair()
		serverWebSocket.accept()

		// load the room, or retrieve it if it's already loaded
		const room = await this.getRoom()

		// connect the client to the room with user information
		room.handleSocketConnect({ 
			sessionId: userId, // Use userId as sessionId for testing
			socket: serverWebSocket 
		})

		// return the websocket connection to the client
		return new Response(null, { status: 101, webSocket: clientWebSocket })
	}

	getRoom() {
		const roomId = this.roomId
		if (!roomId) throw new Error('Missing roomId')

		if (!this.roomPromise) {
			this.roomPromise = (async () => {
				// fetch the room from R2
				const roomFromBucket = await this.r2.get(`rooms/${roomId}`)

				// if it doesn't exist, we'll just create a new empty room
				const initialSnapshot = roomFromBucket
					? ((await roomFromBucket.json()) as RoomSnapshot)
					: undefined

				// create a new TLSocketRoom. This handles all the sync protocol & websocket connections.
				// it's up to us to persist the room state to R2 when needed though.
				return new TLSocketRoom<TLRecord, void>({
					schema,
					initialSnapshot,
					onDataChange: () => {
						// and persist whenever the data in the room changes
						this.schedulePersistToR2()
					},
				})
			})()
		}

		return this.roomPromise
	}

	// we throttle persistance so it only happens every 10 seconds
	schedulePersistToR2 = throttle(async () => {
		if (!this.roomPromise || !this.roomId) return
		const room = await this.getRoom()

		// convert the room to JSON and upload it to R2
		const snapshot = JSON.stringify(room.getCurrentSnapshot())
		await this.r2.put(`rooms/${this.roomId}`, snapshot)
	}, 10_000)

	/**
	 * Validate user session against Miyagi auth system
	 * TEMPORARILY DISABLED FOR TESTING
	 */
	// private async validateUserSession(
	// 	authToken: string, 
	// 	roomId: string, 
	// 	sessionId: string
	// ): Promise<{ valid: boolean; userId?: string }> {
	// 	try {
	// 		const response = await fetch(`${this.miyagiApiUrl}/api/auth/validate-canvas-access`, {
	// 			method: 'POST',
	// 			headers: {
	// 				'Authorization': authToken,
	// 				'Content-Type': 'application/json'
	// 			},
	// 			body: JSON.stringify({ roomId, sessionId })
	// 		})

	// 		if (!response.ok) {
	// 			console.log(`Auth validation failed: ${response.status} ${response.statusText}`)
	// 			return { valid: false }
	// 		}

	// 		const data = await response.json() as { userId: string }
	// 		return { valid: true, userId: data.userId }
	// 	} catch (error) {
	// 		console.error('Auth validation error:', error)
	// 		return { valid: false }
	// 	}
	// }

}
