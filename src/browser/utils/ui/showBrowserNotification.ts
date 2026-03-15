export interface BrowserNotificationOptions {
  body?: string;
  onClick?: () => void;
}

export function showBrowserNotification(
  title: string,
  options: BrowserNotificationOptions = {}
): void {
  if (typeof window === "undefined" || window.Notification === undefined) {
    return;
  }

  const NotificationApi = window.Notification;
  const showNotification = () => {
    const notification = new NotificationApi(title, { body: options.body });
    if (options.onClick) {
      notification.onclick = options.onClick;
    }
  };

  if (NotificationApi.permission === "granted") {
    showNotification();
    return;
  }

  if (NotificationApi.permission !== "denied") {
    void NotificationApi.requestPermission().then((permission) => {
      if (permission === "granted") {
        showNotification();
      }
    });
  }
}
