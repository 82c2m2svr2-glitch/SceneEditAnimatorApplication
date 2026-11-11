import type { ToolId } from '../state/ui';
import { brushTool, ellipseTool, eraserTool, lineTool, penTool, polygonTool, rectTool, starTool, textTool } from './create';
import type { Tool } from './env';
import { cameraTool, handTool, zoomTool } from './nav';
import { nodeTool } from './node';
import { boneTool, ikTool } from './rig';
import { selectTool } from './select';

export const TOOLS: Partial<Record<ToolId, Tool>> = {
  select: selectTool, node: nodeTool, hand: handTool, zoom: zoomTool, camera: cameraTool, bone: boneTool, ik: ikTool,
  pen: penTool, rect: rectTool, ellipse: ellipseTool, polygon: polygonTool, star: starTool, line: lineTool,
  brush: brushTool, eraser: eraserTool, text: textTool,
};

export function getTool(id: ToolId): Tool {
  return TOOLS[id] ?? selectTool;
}
