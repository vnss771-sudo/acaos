// The workspaces router was decomposed into cohesive modules under ./workspaces/.
// This file is kept as the stable import path (./routes/workspaces.js) and simply
// re-exports the assembled router unchanged.
export { workspaceRouter } from './workspaces/index.js'
