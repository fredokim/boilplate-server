-- CreateTable
CREATE TABLE "Graph" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'private',
    "version" INTEGER NOT NULL DEFAULT 1,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Graph_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GraphNode" (
    "id" TEXT NOT NULL,
    "graphId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "positionX" DOUBLE PRECISION NOT NULL,
    "positionY" DOUBLE PRECISION NOT NULL,
    "metadata" JSONB NOT NULL,

    CONSTRAINT "GraphNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GraphEdge" (
    "id" TEXT NOT NULL,
    "graphId" TEXT NOT NULL,
    "edgeId" TEXT NOT NULL,
    "sourceNodeId" TEXT NOT NULL,
    "targetNodeId" TEXT NOT NULL,
    "label" TEXT,
    "metadata" JSONB NOT NULL,

    CONSTRAINT "GraphEdge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TopologyEvent" (
    "id" TEXT NOT NULL,
    "graphId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TopologyEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GraphNodeRuntime" (
    "id" TEXT NOT NULL,
    "graphId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "metrics" JSONB NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "lastUpdated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GraphNodeRuntime_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GraphEdgeRuntime" (
    "id" TEXT NOT NULL,
    "graphId" TEXT NOT NULL,
    "edgeId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "metrics" JSONB NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "lastUpdated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GraphEdgeRuntime_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Graph_ownerId_idx" ON "Graph"("ownerId");

-- CreateIndex
CREATE INDEX "GraphNode_graphId_idx" ON "GraphNode"("graphId");

-- CreateIndex
CREATE UNIQUE INDEX "GraphNode_graphId_nodeId_key" ON "GraphNode"("graphId", "nodeId");

-- CreateIndex
CREATE INDEX "GraphEdge_graphId_idx" ON "GraphEdge"("graphId");

-- CreateIndex
CREATE INDEX "GraphEdge_graphId_sourceNodeId_idx" ON "GraphEdge"("graphId", "sourceNodeId");

-- CreateIndex
CREATE UNIQUE INDEX "GraphEdge_graphId_edgeId_key" ON "GraphEdge"("graphId", "edgeId");

-- CreateIndex
CREATE UNIQUE INDEX "TopologyEvent_eventId_key" ON "TopologyEvent"("eventId");

-- CreateIndex
CREATE INDEX "TopologyEvent_graphId_sequence_idx" ON "TopologyEvent"("graphId", "sequence");

-- CreateIndex
CREATE INDEX "TopologyEvent_occurredAt_idx" ON "TopologyEvent"("occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "TopologyEvent_graphId_sequence_key" ON "TopologyEvent"("graphId", "sequence");

-- CreateIndex
CREATE INDEX "GraphNodeRuntime_graphId_idx" ON "GraphNodeRuntime"("graphId");

-- CreateIndex
CREATE UNIQUE INDEX "GraphNodeRuntime_graphId_nodeId_key" ON "GraphNodeRuntime"("graphId", "nodeId");

-- CreateIndex
CREATE INDEX "GraphEdgeRuntime_graphId_idx" ON "GraphEdgeRuntime"("graphId");

-- CreateIndex
CREATE UNIQUE INDEX "GraphEdgeRuntime_graphId_edgeId_key" ON "GraphEdgeRuntime"("graphId", "edgeId");

-- AddForeignKey
ALTER TABLE "Graph" ADD CONSTRAINT "Graph_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GraphNode" ADD CONSTRAINT "GraphNode_graphId_fkey" FOREIGN KEY ("graphId") REFERENCES "Graph"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GraphEdge" ADD CONSTRAINT "GraphEdge_graphId_fkey" FOREIGN KEY ("graphId") REFERENCES "Graph"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TopologyEvent" ADD CONSTRAINT "TopologyEvent_graphId_fkey" FOREIGN KEY ("graphId") REFERENCES "Graph"("id") ON DELETE CASCADE ON UPDATE CASCADE;

