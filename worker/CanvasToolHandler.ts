/**
 * Canvas Tool Handler - Separate clean implementation of canvas widget tools
 * 
 * This file contains all the canvas tool methods that were getting the TldrawDurableObject polluted.
 * It provides clean, focused methods for canvas widget manipulation.
 */

import { TLSocketRoom } from '@tldraw/sync-core'
import { TLRecord } from '@tldraw/tlschema'
import { IRequest } from 'itty-router'

export class CanvasToolHandler {
  constructor(private getRoom: () => Promise<TLSocketRoom<TLRecord, void>>) {}

  /**
   * Get Pages - Returns all pages in the room
   */
  async handleGetPages(_request: IRequest): Promise<Response> {
    try {
      const room = await this.getRoom()
      const snapshot = room.getCurrentSnapshot()
      
      // Get all page records
      const allRecords = snapshot.documents.map(doc => doc.state)
      const allPages = allRecords.filter((record: any) => record.typeName === 'page')
      
      const pages = allPages.map((page: any) => ({
        id: page.id,
        name: page.name || 'Untitled',
        index: page.index
      }))

      return new Response(JSON.stringify({
        pages,
        defaultPage: pages[0]?.id || null
      }), {
        headers: { 'Content-Type': 'application/json' }
      })

    } catch (error) {
      console.error('Get pages error:', error)
      return new Response(JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      })
    }
  }

  /**
   * Tool 1: Get Widgets - Retrieves widget data from the canvas with optional field selection
   */
  async handleGetWidgets(request: IRequest): Promise<Response> {
    try {
      const url = new URL(request.url)
      const pageId = url.searchParams.get('pageId')
      const ids = url.searchParams.get('ids')?.split(',')
      const fields = url.searchParams.get('fields')?.split(',')

      const room = await this.getRoom()
      const snapshot = room.getCurrentSnapshot()
      
      // Access records correctly - each document in the snapshot is a single record
      const allRecords = snapshot.documents.map(doc => doc.state)
      
      // Filter to miyagi-widget shapes
      let widgetShapes = allRecords.filter((record: any) => 
        record.typeName === 'shape' && 
        record.type === 'miyagi-widget' &&
        (!pageId || record.parentId === pageId)
      )

      // Filter by specific IDs if provided
      if (ids && ids.length > 0) {
        widgetShapes = widgetShapes.filter((shape: any) => ids.includes(shape.id))
      }

      // Map to widget data with requested fields
      const widgets = widgetShapes.map((shape: any) => {
        const widget: any = {
          id: shape.id,
          widgetId: shape.props.widgetId,
          templateId: shape.props.templateId
        }

        // Add requested fields
        if (!fields || fields.includes('htmlContent')) {
          widget.htmlContent = shape.props.htmlContent
        }
        if (!fields || fields.includes('miyagiStorage')) {
          widget.miyagiStorage = shape.props.miyagiStorage || {}
        }
        if (!fields || fields.includes('position')) {
          widget.position = { x: shape.x, y: shape.y }
        }
        if (!fields || fields.includes('size')) {
          widget.size = { w: shape.props.w, h: shape.props.h }
        }
        if (!fields || fields.includes('properties')) {
          widget.properties = shape.props
        }

        return widget
      })

      return new Response(JSON.stringify({
        widgets,
        pageId: pageId || 'page:page'
      }), {
        headers: { 'Content-Type': 'application/json' }
      })

    } catch (error) {
      console.error('Get widgets error:', error)
      return new Response(JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      })
    }
  }

  /**
   * Tool 2: Add Widget - Adds a widget from a template to the canvas
   */
  async handleAddWidget(request: IRequest): Promise<Response> {
    try {
      const body = await request.json() as {
        templateId: string
        pageId?: string
        position?: { x: number; y: number }
        size?: { w: number; h: number }
      }

      const { templateId, pageId, position, size } = body

      if (!templateId) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Missing templateId'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        })
      }

      const room = await this.getRoom()
      
      // Generate unique IDs
      const shapeId = `shape:${this.generateId()}`
      const widgetId = `${templateId}_${Date.now()}`
      const targetPageId = pageId || 'page:page'

      // Get template HTML (for now, use basic template)
      const htmlContent = await this.getTemplateHtml(templateId)

      // Create new miyagi-widget shape (cast to proper type)
      const newShape = {
        id: shapeId,
        typeName: 'shape',
        type: 'miyagi-widget',
        parentId: targetPageId,
        index: 'a1',
        x: position?.x || 300,
        y: position?.y || 200,
        rotation: 0,
        isLocked: false,
        opacity: 1,
        meta: {},
        props: {
          w: size?.w || 300,
          h: size?.h || 200,
          widgetId,
          templateId,
          htmlContent,
          color: 'black',
          miyagiStorage: {}
        }
      } as any

      // Add to room using the correct tldraw method
      await room.updateStore((store) => {
        store.put(newShape)
      })

      return new Response(JSON.stringify({
        success: true,
        shapeId,
        widgetId,
        templateId
      }), {
        headers: { 'Content-Type': 'application/json' }
      })

    } catch (error) {
      console.error('Add widget error:', error)
      return new Response(JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      })
    }
  }

  /**
   * Tool 4: Edit Widget HTML - Updates the HTML content of an existing widget
   */
  async handleEditWidgetHtml(request: IRequest): Promise<Response> {
    try {
      const shapeId = request.params.shapeId
      const body = await request.json() as {
        htmlContent: string
        preserveStorage?: boolean
      }

      const { htmlContent, preserveStorage } = body

      if (!htmlContent) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Missing htmlContent'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        })
      }

      const room = await this.getRoom()
      const snapshot = room.getCurrentSnapshot()
      
      // Access records correctly - each document in the snapshot is a single record
      const allRecords = snapshot.documents.map(doc => doc.state)
      
      // Find the shape
      const shape = allRecords.find((record: any) => 
        record.id === shapeId && 
        record.typeName === 'shape' && 
        record.type === 'miyagi-widget'
      ) as any

      if (!shape || shape.type !== 'miyagi-widget') {
        return new Response(JSON.stringify({
          success: false,
          error: `Widget shape not found: ${shapeId}`
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        })
      }

      // Process HTML with miyagiStorage placeholders
      const processedHtml = this.processTemplate(htmlContent, {
        widgetId: (shape as any).props.widgetId,
        miyagiStorage: (shape as any).props.miyagiStorage || {}
      })

      // Update the shape
      const updatedShape = {
        ...shape,
        props: {
          ...shape.props,
          htmlContent: processedHtml,
          miyagiStorage: preserveStorage ? shape.props.miyagiStorage : {}
        }
      }

      await room.updateStore((store) => {
        store.put(updatedShape)
      })

      return new Response(JSON.stringify({
        success: true,
        processedHtml
      }), {
        headers: { 'Content-Type': 'application/json' }
      })

    } catch (error) {
      console.error('Edit widget HTML error:', error)
      return new Response(JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      })
    }
  }

  /**
   * Tool 3: Generate Widget - Generates a new widget using AI (basic implementation)
   */
  async handleGenerateWidget(request: IRequest): Promise<Response> {
    try {
      const body = await request.json() as {
        prompt: string
        style?: string
        pageId?: string
        position?: { x: number; y: number }
        autoAdd?: boolean
      }

      const { prompt, pageId, position, autoAdd } = body

      if (!prompt) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Missing prompt'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        })
      }

      // Basic AI generation (for now, create a simple HTML based on prompt)
      const htmlContent = this.generateBasicWidget(prompt)
      const templateId = 'generated-widget'

      const result: any = {
        htmlContent,
        templateId
      }

      // Auto-add to canvas if requested
      if (autoAdd) {
        const room = await this.getRoom()
        const shapeId = `shape:${this.generateId()}`
        const widgetId = `generated_${Date.now()}`
        const targetPageId = pageId || 'page:page'

        const newShape = {
          id: shapeId,
          typeName: 'shape',
          type: 'miyagi-widget',
          parentId: targetPageId,
          index: 'a1',
          x: position?.x || 400,
          y: position?.y || 300,
          rotation: 0,
          isLocked: false,
          opacity: 1,
          meta: {},
          props: {
            w: 300,
            h: 200,
            widgetId,
            templateId,
            htmlContent,
            color: 'black',
            miyagiStorage: {}
          }
        } as any

        await room.updateStore((store) => {
          store.put(newShape)
        })

        result.shapeId = shapeId
        result.widgetId = widgetId
      }

      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' }
      })

    } catch (error) {
      console.error('Generate widget error:', error)
      return new Response(JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      })
    }
  }

  // ===================================================================
  // HELPER METHODS
  // ===================================================================

  private generateId(): string {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
  }

  private async getTemplateHtml(templateId: string): Promise<string> {
    // Basic templates for now
    const templates: Record<string, string> = {
      timer: '<div style="padding: 20px; background: #f0f0f0; border-radius: 8px;"><h3>Timer Widget</h3><div>00:00</div></div>',
      notepad: '<div style="padding: 20px; background: #fff; border: 1px solid #ddd; border-radius: 8px;"><h3>Notepad</h3><textarea style="width: 100%; height: 100px; border: none; resize: none;" placeholder="{{miyagi-storage:notepad-content}}"></textarea></div>',
      clock: '<div style="padding: 20px; background: #333; color: white; border-radius: 8px; text-align: center;"><h3>Clock</h3><div id="clock-time">12:00 PM</div></div>',
      weather: '<div style="padding: 20px; background: linear-gradient(135deg, #74b9ff, #0984e3); color: white; border-radius: 8px;"><h3>Weather</h3><div>Sunny, 72°F</div></div>'
    }

    return templates[templateId] || `<div style="padding: 20px; background: #f8f9fa; border-radius: 8px;"><h3>${templateId}</h3><p>Widget content</p></div>`
  }

  private generateBasicWidget(prompt: string): string {
    // Very basic AI generation based on keywords in prompt
    const lowerPrompt = prompt.toLowerCase()
    
    if (lowerPrompt.includes('calculator')) {
      return '<div style="padding: 20px; background: #f8f9fa; border-radius: 8px;"><h3>Calculator</h3><div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; margin-top: 10px;"><button>7</button><button>8</button><button>9</button><button>/</button><button>4</button><button>5</button><button>6</button><button>*</button><button>1</button><button>2</button><button>3</button><button>-</button><button>0</button><button>.</button><button>=</button><button>+</button></div></div>'
    } else if (lowerPrompt.includes('todo') || lowerPrompt.includes('task')) {
      return '<div style="padding: 20px; background: #f8f9fa; border-radius: 8px;"><h3>Todo List</h3><div><input type="checkbox"> Task 1</div><div><input type="checkbox"> Task 2</div><div><input type="checkbox"> Task 3</div></div>'
    } else {
      return `<div style="padding: 20px; background: #f8f9fa; border-radius: 8px;"><h3>Generated Widget</h3><p>${prompt}</p></div>`
    }
  }

  private processTemplate(htmlContent: string, context: { widgetId: string; miyagiStorage: Record<string, string> }): string {
    // Replace {{miyagi-storage:key}} placeholders with actual values
    return htmlContent.replace(/\{\{miyagi-storage:([^}]+)\}\}/g, (_, key) => {
      return context.miyagiStorage[key] || ''
    })
  }
}
