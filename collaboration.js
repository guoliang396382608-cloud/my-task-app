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
    const POLLING_INTERVAL = 5000; // 轮询间隔，作为实时订阅失败的备份

    // --- 初始化 ---
    // [修正] 增加对 Supabase 库是否存在的检查，使代码更健壮
    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
        console.error("Supabase 客户端库未能正确加载，协作模块无法启动。请检查网络连接和 index.html 中的脚本引用。");
        return;
    }
    const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    
    // [修正] 将 Supabase 客户端实例赋给 window，供 React 应用使用
    window.supabase = supabaseClient;

    let localDataVersion = 0;
    let statusCallbacks = [];
    let dataCallbacks = [];
    let isSyncing = false; // [新增] 防止并发同步的状态锁

    function processRemoteData(remoteJsonData, version) {
        console.log(`[协作模块] 接收到远程版本: ${version}。 本地版本: ${localDataVersion}。`);
        [cite_start]const remoteData = JSON.parse(remoteJsonData); [cite: 3]
        localStorage.setItem(TASKS_KEY, JSON.stringify(remoteData.tasks || []));
        localStorage.setItem(DELETED_TASKS_KEY, JSON.stringify(remoteData.deletedTasks || []));
        localStorage.setItem(MANAGEMENT_KEY, JSON.stringify(remoteData.managementData || {}));
        localStorage.setItem(VERSION_KEY, version.toString());
        [cite_start]localDataVersion = version; [cite: 4]
        console.log("[协作模块] 本地数据已从服务器更新。");
        triggerDataUpdate(remoteData);
    }

    async function fetchRemoteData() {
        triggerStatusChange('syncing');
        try {
            [cite_start]const { data, error } = await supabaseClient.from(SYNC_TABLE).select('data, version').order('version', { ascending: false }).limit(1).single(); [cite: 5]
            [cite_start]if (error && error.code !== 'PGRST116') { [cite: 6]
                console.error("[协作模块] 获取远程数据出错:", error);
                triggerStatusChange('error');
                return;
            }
            if (!data) {
                console.log("[协作模块] 云端数据库为空，上传本地数据作为初始版本。");
                [cite_start]await syncToRemote(); [cite: 8]
                triggerStatusChange('connected');
                return;
            }
            if (data.version > localDataVersion) {
                [cite_start]processRemoteData(data.data, data.version); [cite: 9]
            }
            triggerStatusChange('connected');
        } catch (err) {
            [cite_start]console.error('[协作模块] 获取远程数据失败:', err); [cite: 10]
            triggerStatusChange('error');
        }
    }

    // [修正] 重构 syncToRemote 以处理版本冲突和数据合并
    async function syncToRemote(dataToSync) {
        if (isSyncing) {
            console.warn('[协作模块] 已有同步正在进行中，本次同步请求被忽略。');
            return;
        }
        isSyncing = true;
        triggerStatusChange('syncing');

        try {
            const localData = dataToSync || {
                tasks: JSON.parse(localStorage.getItem(TASKS_KEY) || '[]'),
                deletedTasks: JSON.parse(localStorage.getItem(DELETED_TASKS_KEY) || '[]'),
                managementData: JSON.parse(localStorage.getItem(MANAGEMENT_KEY) || '{}')
            [cite_start]}; [cite: 15]

            [cite_start]const { data: latestVersionData, error: versionError } = await supabaseClient.from(SYNC_TABLE).select('version').order('version', { ascending: false }).limit(1).single(); [cite: 11]
            [cite_start]if (versionError && versionError.code !== 'PGRST116') { [cite: 12]
                console.error("[协作模块] 同步前获取最新版本失败:", versionError);
                throw versionError;
            }
            [cite_start]const latestVersion = latestVersionData ? latestVersionData.version : 0; [cite: 13]
            [cite_start]const newVersion = latestVersion + 1; [cite: 14]

            [cite_start]const { error } = await supabaseClient.from(SYNC_TABLE).insert([{ data: JSON.stringify(localData), version: newVersion }]); [cite: 16]

            if (error) {
                // [核心修正] 处理版本冲突 (数据丢失的关键点)
                if (error.code === '23505') { // '23505' 是 unique_violation
                    console.warn('[协作模块] 版本冲突！检测到服务器上有更新的数据。');
                    console.log('[协作模块] 正在执行“获取-合并-重试”操作...');
                    
                    // 1. 获取服务器上的最新数据
                    const { data: serverData, error: fetchErr } = await supabaseClient.from(SYNC_TABLE).select('data').order('version', { ascending: false }).limit(1).single();
                    if (fetchErr) throw new Error("在冲突解决期间，获取最新数据失败: " + fetchErr.message);

                    // 2. 合并数据 (简单策略：本地修改覆盖远程的)
                    // 注意：这是一个简单合并，更复杂的场景可能需要UI提示用户手动合并
                    const remoteState = JSON.parse(serverData.data);
                    const mergedData = { ...remoteState, ...localData };

                    console.log('[协作模块] 数据合并完成，将以新版本重新提交。');
                    // 3. 使用合并后的数据再次尝试同步 (递归调用，但由状态锁防止无限循环)
                    isSyncing = false; // 解锁后再次调用
                    await syncToRemote(mergedData);

                } else {
                    throw error;
                }
            } else {
                [cite_start]localStorage.setItem(VERSION_KEY, newVersion.toString()); [cite: 19]
                localDataVersion = newVersion;
                console.log(`[协作模块] 本地数据成功同步至云端，版本号 ${newVersion}。`);
                [cite_start]triggerStatusChange('connected'); [cite: 20]
            }
        } catch (err) {
            console.error('[协作模块] 同步至云端失败:', err);
            triggerStatusChange('error');
        } finally {
            isSyncing = false;
        }
    }

    function subscribeToRemoteChanges() {
        supabaseClient.channel('collaboration_channel')
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: SYNC_TABLE }, (payload) => {
                const newVersion = payload.new.version;
                if (newVersion > localDataVersion) {
                    processRemoteData(payload.new.data, newVersion);
                }
            [cite_start]}) [cite: 21]
            .subscribe((status) => {
                 if (status === 'SUBSCRIBED') { console.log('[协作模块] 已连接到实时变更频道。'); }
            [cite_start]}); [cite: 22]
    }
    
    async function pollForChanges() {
        if (isSyncing) return; // 如果正在同步，则跳过本次轮询
        try {
            const { data, error } = await supabaseClient.from(SYNC_TABLE).select('version').order('version', { ascending: false }).limit(1).single();
            if (error && error.code !== 'PGRST116') { return; [cite_start]} [cite: 23]
            if (data && data.version > localDataVersion) {
                console.log("[轮询] 检测到服务器版本更新，正在拉取...");
                [cite_start]fetchRemoteData(); [cite: 24]
            }
        } catch (err) {
            [cite_start]console.warn("[轮询] 轮询过程中出错:", err.message); [cite: 25]
        }
    }

    function triggerStatusChange(status) {
        [cite_start]statusCallbacks.forEach(cb => cb(status)); [cite: 26]
    }
    function triggerDataUpdate(data) {
        [cite_start]dataCallbacks.forEach(cb => cb(data)); [cite: 27]
    }

    window.Collaboration = {
        setup: (callbacks) => {
            [cite_start]if (callbacks.onStatusChange) statusCallbacks.push(callbacks.onStatusChange); [cite: 28]
            if (callbacks.onDataUpdate) dataCallbacks.push(callbacks.onDataUpdate);
        },
        sync: (dataToSync) => {
            clearTimeout(window.Collaboration._syncTimeout);
            // 使用 debounce 模式，防止过于频繁的同步请求
            [cite_start]window.Collaboration._syncTimeout = setTimeout(() => syncToRemote(dataToSync), 500); [cite: 29]
        },
        _syncTimeout: null
    };

    async function init() {
        const savedVersion = localStorage.getItem(VERSION_KEY);
        [cite_start]localDataVersion = savedVersion ? parseInt(savedVersion, 10) : 0; [cite: 31]
        
        await fetchRemoteData(); 
        subscribeToRemoteChanges();
        setInterval(pollForChanges, POLLING_INTERVAL);
        
        console.log("协作模块初始化完成，正在启动主应用...");
        // 确保 startApp 函数存在再调用
        if (window.startApp) {
            [cite_start]window.startApp(); [cite: 32]
        }
    }
    
    [cite_start]init(); [cite: 30]
})();
