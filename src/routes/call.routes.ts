import { Router } from "express";
import { CallController } from "../controllers/call.controller.js";
import { authMiddleware } from "../middleware/auth.middleware.js";

const router = Router();

router.post("/generate-token", authMiddleware, CallController.generateToken);
router.get("/history", authMiddleware, CallController.getCallHistory);
router.post("/decline", authMiddleware, CallController.declineCall);

export const CallRoutes = router;
