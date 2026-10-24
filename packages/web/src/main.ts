import { mount } from "svelte";
import "./app.css";
import App from "./App.svelte";
import { ui } from "./lib/state.svelte";

mount(App, { target: document.getElementById("app")! });
ui.init();
