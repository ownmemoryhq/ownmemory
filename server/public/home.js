// Setup wizard: copy buttons for the connector URL and the Instructions for Claude text.
for (const button of document.querySelectorAll("[data-copy]")) {
	const label = button.textContent;
	button.addEventListener("click", async () => {
		const text = document.getElementById(button.dataset.copy).textContent.trim();
		try {
			await navigator.clipboard.writeText(text);
			button.textContent = "Copied";
		} catch {
			button.textContent = "Copy failed: select the text instead";
		}
		setTimeout(() => {
			button.textContent = label;
		}, 2500);
	});
}
