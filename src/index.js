import { Container, getContainer } from "@cloudflare/containers";
import { env } from "cloudflare:workers";

export class CoinFlipGame extends Container {
	defaultPort = 5000;
	sleepAfter = "30m";
	envVars = {
		NODE_ENV: env.NODE_ENV ?? "production",
		PORT: "5000",
		MONGODB_URI: env.MONGODB_URI ?? "",
		JWT_SECRET: env.JWT_SECRET ?? "",
		JWT_EXPIRES_IN: env.JWT_EXPIRES_IN ?? "7d",
		ADMIN_SECRET: env.ADMIN_SECRET ?? "",
		FRONTEND_URL: env.FRONTEND_URL ?? "",
		EMAIL_HOST: env.EMAIL_HOST ?? "",
		EMAIL_PORT: env.EMAIL_PORT ?? "",
		EMAIL_USER: env.EMAIL_USER ?? "",
		EMAIL_PASS: env.EMAIL_PASS ?? ""
	};

	onStart() {
		console.log("CoinFlip container started");
	}

	onStop() {
		console.log("CoinFlip container stopped");
	}

	onError(error) {
		console.log("CoinFlip container error:", error);
	}
}

export default {
	async fetch(request, env) {
		const container = await getContainer(env.GAME_CONTAINER);
		return container.fetch(request);
	}
};
