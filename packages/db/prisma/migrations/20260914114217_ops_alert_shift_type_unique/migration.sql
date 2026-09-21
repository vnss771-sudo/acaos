-- CreateIndex
CREATE UNIQUE INDEX "OpsAlert_shiftRecordId_alertType_key" ON "OpsAlert"("shiftRecordId", "alertType");
