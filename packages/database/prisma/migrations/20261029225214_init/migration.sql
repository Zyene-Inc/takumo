-- CreateEnum
CREATE TYPE "Role" AS ENUM ('owner', 'admin', 'planner', 'estimator', 'operator');

-- CreateEnum
CREATE TYPE "Provenance" AS ENUM ('data', 'stated', 'assumed');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('open', 'in_progress', 'done', 'cancelled');

-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('open', 'won', 'lost');

-- CreateEnum
CREATE TYPE "FactStatus" AS ENUM ('pending', 'approved', 'superseded', 'rejected');

-- CreateTable
CREATE TABLE "Org" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'trial',
    "stripeCustomerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Org_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Member" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'planner',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkCenter" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT,
    "hourlyRate" DECIMAL(10,2),
    "efficiency" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "shifts" JSONB,
    "provenance" "Provenance" NOT NULL DEFAULT 'data',
    "sourceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkCenter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarDay" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "workCenterId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "availableHours" DOUBLE PRECISION NOT NULL,
    "reason" TEXT,

    CONSTRAINT "CalendarDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Operator" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "skills" TEXT[],
    "hourlyRate" DECIMAL(10,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Operator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Material" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "spec" TEXT,
    "unitCost" DECIMAL(12,4),
    "unit" TEXT NOT NULL DEFAULT 'ea',
    "leadTimeDays" INTEGER,
    "provenance" "Provenance" NOT NULL DEFAULT 'data',

    CONSTRAINT "Material_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "paymentTermDays" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Part" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "partNo" TEXT NOT NULL,
    "rev" TEXT NOT NULL DEFAULT 'A',
    "description" TEXT,
    "customerId" TEXT,
    "materialId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Part_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Routing" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "workCenterId" TEXT NOT NULL,
    "setupMin" DOUBLE PRECISION NOT NULL,
    "runMinPerUnit" DOUBLE PRECISION NOT NULL,
    "altWorkCenterIds" TEXT[],
    "provenance" "Provenance" NOT NULL DEFAULT 'data',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,

    CONSTRAINT "Routing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BomLine" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "parentPartId" TEXT NOT NULL,
    "childPartId" TEXT NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "BomLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "orderNo" TEXT NOT NULL,
    "customerId" TEXT,
    "partId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "dueDate" DATE NOT NULL,
    "price" DECIMAL(12,2),
    "priority" INTEGER NOT NULL DEFAULT 0,
    "status" "OrderStatus" NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "routingSeq" INTEGER NOT NULL,
    "workCenterId" TEXT,
    "plannedStart" TIMESTAMP(3),
    "plannedEnd" TIMESTAMP(3),
    "actualStart" TIMESTAMP(3),
    "actualEnd" TIMESTAMP(3),
    "actualSetupMin" DOUBLE PRECISION,
    "actualRunMin" DOUBLE PRECISION,
    "qtyGood" INTEGER,
    "qtyScrap" INTEGER,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quote" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "quoteNo" TEXT NOT NULL,
    "customerId" TEXT,
    "partId" TEXT,
    "qty" INTEGER NOT NULL,
    "price" DECIMAL(12,2),
    "leadTimeDays" INTEGER,
    "estCost" DECIMAL(12,2),
    "actualCost" DECIMAL(12,2),
    "status" "QuoteStatus" NOT NULL DEFAULT 'open',
    "quotedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rfqId" TEXT,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Rfq" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceId" TEXT,
    "extracted" JSONB,
    "status" TEXT NOT NULL DEFAULT 'new',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Rfq_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Source" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "filePath" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "profile" TEXT,
    "summary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocChunk" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "page" INTEGER,
    "meta" JSONB,
    "embedding" vector(1024),

    CONSTRAINT "DocChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Fact" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "attribute" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "statedBy" TEXT,
    "evidence" TEXT,
    "status" "FactStatus" NOT NULL DEFAULT 'pending',
    "supersedesFactId" TEXT,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Fact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "toolCalls" JSONB,
    "citations" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleRun" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "output" JSONB,
    "solverStatus" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduleRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Org_stripeCustomerId_key" ON "Org"("stripeCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "Member_orgId_userId_key" ON "Member"("orgId", "userId");

-- CreateIndex
CREATE INDEX "WorkCenter_orgId_idx" ON "WorkCenter"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkCenter_orgId_name_key" ON "WorkCenter"("orgId", "name");

-- CreateIndex
CREATE INDEX "CalendarDay_orgId_idx" ON "CalendarDay"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarDay_workCenterId_date_key" ON "CalendarDay"("workCenterId", "date");

-- CreateIndex
CREATE INDEX "Operator_orgId_idx" ON "Operator"("orgId");

-- CreateIndex
CREATE INDEX "Material_orgId_idx" ON "Material"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Material_orgId_name_key" ON "Material"("orgId", "name");

-- CreateIndex
CREATE INDEX "Customer_orgId_idx" ON "Customer"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_orgId_name_key" ON "Customer"("orgId", "name");

-- CreateIndex
CREATE INDEX "Part_orgId_idx" ON "Part"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Part_orgId_partNo_rev_key" ON "Part"("orgId", "partNo", "rev");

-- CreateIndex
CREATE INDEX "Routing_orgId_idx" ON "Routing"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Routing_partId_seq_key" ON "Routing"("partId", "seq");

-- CreateIndex
CREATE INDEX "BomLine_orgId_idx" ON "BomLine"("orgId");

-- CreateIndex
CREATE INDEX "Order_orgId_status_idx" ON "Order"("orgId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Order_orgId_orderNo_key" ON "Order"("orgId", "orderNo");

-- CreateIndex
CREATE INDEX "Job_orgId_idx" ON "Job"("orgId");

-- CreateIndex
CREATE INDEX "Quote_orgId_status_idx" ON "Quote"("orgId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_orgId_quoteNo_key" ON "Quote"("orgId", "quoteNo");

-- CreateIndex
CREATE INDEX "Rfq_orgId_idx" ON "Rfq"("orgId");

-- CreateIndex
CREATE INDEX "Source_orgId_idx" ON "Source"("orgId");

-- CreateIndex
CREATE INDEX "DocChunk_orgId_idx" ON "DocChunk"("orgId");

-- CreateIndex
CREATE INDEX "Fact_orgId_subjectType_subjectId_idx" ON "Fact"("orgId", "subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "Conversation_orgId_userId_idx" ON "Conversation"("orgId", "userId");

-- CreateIndex
CREATE INDEX "ScheduleRun_orgId_idx" ON "ScheduleRun"("orgId");

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarDay" ADD CONSTRAINT "CalendarDay_workCenterId_fkey" FOREIGN KEY ("workCenterId") REFERENCES "WorkCenter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Part" ADD CONSTRAINT "Part_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Part" ADD CONSTRAINT "Part_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Routing" ADD CONSTRAINT "Routing_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Routing" ADD CONSTRAINT "Routing_workCenterId_fkey" FOREIGN KEY ("workCenterId") REFERENCES "WorkCenter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BomLine" ADD CONSTRAINT "BomLine_parentPartId_fkey" FOREIGN KEY ("parentPartId") REFERENCES "Part"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BomLine" ADD CONSTRAINT "BomLine_childPartId_fkey" FOREIGN KEY ("childPartId") REFERENCES "Part"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "Rfq"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocChunk" ADD CONSTRAINT "DocChunk_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
