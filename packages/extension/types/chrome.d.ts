declare namespace chrome {
    namespace action {
        function openPopup(): Promise<void>;
        function setBadgeText(details: { text: string }): void;
        function setBadgeBackgroundColor(details: { color: string }): void;
        function setIcon(details: { path: string }): void;
        function setTitle(details: { title: string }): void;
    }
}
