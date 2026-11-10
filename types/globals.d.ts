// Ambient type declarations for Chrome MV3 extension globals and vendor libraries.

declare function importScripts(...urls: string[]): void;

declare namespace chrome {
  namespace runtime {
    interface Manifest {
      name: string;
      version: string;
      manifest_version: number;
      [key: string]: any;
    }

    interface MessageSender {
      tab?: chrome.tabs.Tab;
      frameId?: number;
      id?: string;
      url?: string;
      origin?: string;
    }

    interface InstalledDetails {
      reason: string;
      previousVersion?: string;
      id?: string;
    }

    const lastError: { message?: string } | undefined;

    function getManifest(): Manifest;

    function sendMessage(message: any): Promise<any>;
    function sendMessage(message: any, responseCallback: (response: any) => void): void;

    const onMessage: {
      addListener(
        callback: (
          message: any,
          sender: MessageSender,
          sendResponse: (response?: any) => void
        ) => boolean | void
      ): void;
      removeListener(callback: (...args: any[]) => void): void;
    };

    const onInstalled: {
      addListener(callback: (details: InstalledDetails) => void | Promise<void>): void;
    };
  }

  namespace storage {
    interface StorageArea {
      get(keys?: string | string[] | Record<string, any> | null): Promise<Record<string, any>>;
      get(
        keys: string | string[] | Record<string, any> | null,
        callback: (items: Record<string, any>) => void
      ): void;
      set(items: Record<string, any>): Promise<void>;
      set(items: Record<string, any>, callback: () => void): void;
      remove(keys: string | string[]): Promise<void>;
      remove(keys: string | string[], callback: () => void): void;
    }

    const local: StorageArea;
  }

  namespace alarms {
    interface Alarm {
      name: string;
      scheduledTime?: number;
      periodInMinutes?: number;
    }

    interface AlarmCreateInfo {
      when?: number;
      delayInMinutes?: number;
      periodInMinutes?: number;
    }

    function create(name: string, alarmInfo: AlarmCreateInfo): void;
    function clear(name?: string): Promise<boolean>;

    const onAlarm: {
      addListener(callback: (alarm: Alarm) => void): void;
    };
  }

  namespace tabs {
    interface Tab {
      id?: number;
      url?: string;
      title?: string;
      active?: boolean;
      status?: string;
      windowId?: number;
    }

    interface TabChangeInfo {
      status?: string;
      url?: string;
      title?: string;
    }

    function create(createProperties: { url?: string; active?: boolean }): Promise<Tab>;
    function query(queryInfo: {
      active?: boolean;
      currentWindow?: boolean;
      url?: string | string[];
    }): Promise<Tab[]>;
    function sendMessage(tabId: number, message: any): Promise<any>;
    function remove(tabIds: number | number[]): Promise<void>;

    const onUpdated: {
      addListener(
        callback: (tabId: number, changeInfo: TabChangeInfo, tab: Tab) => void
      ): void;
      removeListener(
        callback: (tabId: number, changeInfo: TabChangeInfo, tab: Tab) => void
      ): void;
    };
  }
}

declare namespace Papa {
  function unparse(data: any[], config?: Record<string, any>): string;
}

declare namespace XLSX {
  type WorkSheet = Record<string, any>;
  interface WorkBook {
    SheetNames: string[];
    Sheets: Record<string, WorkSheet>;
  }

  const utils: {
    json_to_sheet(data: Record<string, any>[], opts?: Record<string, any>): WorkSheet;
    book_new(): WorkBook;
    book_append_sheet(workbook: WorkBook, worksheet: WorkSheet, name?: string): void;
    encode_cell(cell: { c: number; r: number }): string;
  };

  function writeFile(workbook: WorkBook, filename: string, opts?: Record<string, any>): void;
}

interface Window {
  app?: any;
}

