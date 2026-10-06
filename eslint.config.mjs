import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

// The same rules the Obsidian community directory runs on submitted plugins.
export default defineConfig([
	globalIgnores(["main.js", "node_modules/"]),
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: { allowDefaultProject: ["eslint.config.mjs"] },
			},
		},
	},
]);
