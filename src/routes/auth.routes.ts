import { Router } from "express";
import { AuthController } from "../controllers/auth.controller.js";
import { authMiddleware } from "../middleware/auth.middleware.js";

const router = Router();

router.post("/login", AuthController.login);
router.get("/profile", authMiddleware, AuthController.getProfile);
router.post("/login-with-flybook", AuthController.loginWithFlyBook);
router.post(
  "/register-fcm-token",
  authMiddleware,
  AuthController.registerFCMToken,
);
// iOS PushKit VoIP token (used for guaranteed call delivery in background/killed state)
router.post(
  "/register-voip-token",
  authMiddleware,
  AuthController.registerVoipToken,
);

export const AuthRoutes = router;
