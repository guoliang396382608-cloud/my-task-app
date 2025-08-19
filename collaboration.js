// collaboration.js (最终修正版)
(function() {
    // --- Supabase 配置 ---
    const SUPABASE_URL = 'https://gpcsknsnwatqqcnywuiv.supabase.co';
    const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdwY3NrbnNud2F0cXFjbnl3dWl2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTQzNzc5MTMsImV4cCI6MjA2OTk1MzkxM30.M-02UaHW22nU0MLmRtiIIlcmb7tnceoisFIkTK05NCY';
    const SYNC_TABLE = 'system_data';

    // --- LocalStorage 键 ---
    const TASKS_KEY = 'task_manager_tasks_v4.2.3';
    const DELETED_TASKS_KEY = 'task_manager_deletedTasks_v4.2.3';
    const MANAGEMENT_KEY = 'task_manager_managementData_v4.2.3';
    const VERSION_KEY = 'collab_data_version_v4.2.3';
    
    // --- 同步常量 ---
    const POLLING_INTERVAL = 5000;

    // --- 初始化 (已修正) ---
    const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    window.supabase = supabaseClient;

    let localDataVersion = 0;
    let statusCallbacks = [];
    let dataCallbacks = [];

    function processRemoteData(remoteJsonData, version) {
        console.log(`[协作模块] 接收到远程版本: ${version}。 本地版本: ${localDataVersion}。`);
        const remoteData = JSON.parse(remoteJsonData);
        localStorage.setItem(TASKS_KEY, JSON.stringify(remoteData.tasks || []));
        localStorage.setItem(DELETED_TASKS_KEY, JSON.stringify(remoteData.deletedTasks || []));
        localStorage.setItem(MANAGEMENT_KEY, JSON.stringify(remoteData.managementData || {}));
        localStorage.setItem(VERSION_KEY, version.toString());
        localDataVersion = version;
        console.log("[协作模块] 本地数据已从服务器更新。");
        triggerDataUpdate(remoteData);
    }

    async function fetchRemoteData() {
        triggerStatusChange('syncing');
        try {
            const { data, error } = await supabaseClient.from(SYNC_TABLE).select('data, version').order('version', { ascending: false }).limit(1).single();
            if (error && error.code !== 'PGRST116') { console.error("[协作模块] 获取远程数据出错:", error); triggerStatusChange('error'); return; }
            if (!data) {
                console.log("[协作模块] 云端数据库为空，上传本地数据作为初始版本。");
                await syncToRemote();
                triggerStatusChange('connected');
                return;
            }
            if (data.version > localDataVersion) { processRemoteData(data.data, data.version); }
            triggerStatusChange('connected');
        } catch (err) { console.error('[协作模块] 获取远程数据失败:', err); triggerStatusChange('error'); }
    }

    async function syncToRemote(dataToSync) {
        triggerStatusChange('syncing');
        try {
            const { data: latestVersionData, error: versionError } = await supabaseClient.from(SYNC_TABLE).select('version').order('version', { ascending: false }).limit(1).single();
            if (versionError && versionError.code !== 'PGRST116') { console.error("[协作模块] 同步前获取最新版本失败:", versionError); triggerStatusChange('error'); return; }
            const latestVersion = latestVersionData ? latestVersionData.version : 0;
            const newVersion = latestVersion + 1;
            const localData = dataToSync || {
                tasks: JSON.parse(localStorage.getItem(TASKS_KEY) || '[]'),
                deletedTasks: JSON.parse(localStorage.getItem(DELETED_TASKS_KEY) || '[]'),
                managementData: JSON.parse(localStorage.getItem(MANAGEMENT_KEY) || '{}')
            };
            const { error } = await supabaseClient.from(SYNC_TABLE).insert([{ data: JSON.stringify(localData), version: newVersion }]);
            if (error) {
                console.error('[协作模块] 上传数据至云端出错:', error);
                triggerStatusChange('error');
                if (error.code === '23505') { console.log('[协作模块] 检测到版本冲突，正在获取最新数据...'); fetchRemoteData(); }
                return;
            }
            localStorage.setItem(VERSION_KEY, newVersion.toString());
            localDataVersion = newVersion;
            console.log(`[协作模块] 本地数据成功同步至云端，版本号 ${newVersion}。`);
            triggerStatusChange('connected');
        } catch (err) { console.error('[协作模块] 同步至云端失败:', err); triggerStatusChange('error'); }
    }

    function subscribeToRemoteChanges() {
        supabaseClient.channel('collaboration_channel')
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: SYNC_TABLE }, (payload) => {
                const newVersion = payload.new.version;
                if (newVersion > localDataVersion) { processRemoteData(payload.new.data, newVersion); }
            })
            .subscribe((status) => {
                 if (status === 'SUBSCRIBED') { console.log('[协作模块] 已连接到实时变更频道。'); }
            });
    }
    
    async function pollForChanges() {
        try {
            const { data, error } = await supabaseClient.from(SYNC_TABLE).select('version').order('version', { ascending: false }).limit(1).single();
            if (error && error.code !== 'PGRST116') { return; }
            if (data && data.version > localDataVersion) { fetchRemoteData(); }
        } catch (err) { console.warn("[轮询] 轮询过程中出错:", err.message); }
    }

    function triggerStatusChange(status) { statusCallbacks.forEach(cb => cb(status)); }
    function triggerDataUpdate(data) { dataCallbacks.forEach(cb => cb(data)); }

    window.Collaboration = {
        setup: (callbacks) => {
            if (callbacks.onStatusChange) statusCallbacks.push(callbacks.onStatusChange);
            if (callbacks.onDataUpdate) dataCallbacks.push(callbacks.onDataUpdate);
        },
        sync: (dataToSync) => {
            clearTimeout(window.Collaboration._syncTimeout);
            window.Collaboration._syncTimeout = setTimeout(() => syncToRemote(dataToSync), 500);
        },
        _syncTimeout: null
    };
    
    async function init() {
        const savedVersion = localStorage.getItem(VERSION_KEY);
        localDataVersion = savedVersion ? parseInt(savedVersion, 10) : 0;
        await fetchRemoteData(); 
        subscribeToRemoteChanges();
        setInterval(pollForChanges, POLLING_INTERVAL);
        console.log("协作模块初始化完成，正在启动主应用...");
        if (window.startApp) { window.startApp(); }
    }
    
    init();
})();
