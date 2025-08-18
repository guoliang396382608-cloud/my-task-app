// collaboration.js
(function() {
    // --- Configuración de Supabase (Manten tus credenciales aquí) ---
    const SUPABASE_URL = 'https://gpcsknsnwatqqcnywuiv.supabase.co';
    const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdwY3NrbnNud2F0cXFjbnl3dWl2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTQzNzc5MTMsImV4cCI6MjA2OTk1MzkxM30.M-02UaHW22nU0MLmRtiIIlcmb7tnceoisFIkTK05NCY';
    const SYNC_TABLE = 'system_data'; // Nombre de la tabla en Supabase

    // --- Claves de LocalStorage (Alineadas con index.html v4.2.3) ---
    const TASKS_KEY = 'task_manager_tasks_v4.2.3';
    const DELETED_TASKS_KEY = 'task_manager_deletedTasks_v4.2.3';
    const MANAGEMENT_KEY = 'task_manager_managementData_v4.2.3';
    const VERSION_KEY = 'collab_data_version_v4.2.3';
    
    // --- Constantes de Sincronización ---
    const POLLING_INTERVAL = 5000; // 5 segundos

    // --- Inicialización ---
    const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    let localDataVersion = 0;
    let statusCallbacks = [];
    let dataCallbacks = [];

    /**
     * Procesa los datos recibidos del servidor y actualiza el almacenamiento local.
     * @param {string} remoteJsonData - Los datos en formato JSON.
     * @param {number} version - La versión de los datos remotos.
     */
    function processRemoteData(remoteJsonData, version) {
        console.log(`[Collab] Recibiendo versión remota: ${version}. Versión local: ${localDataVersion}.`);
        const remoteData = JSON.parse(remoteJsonData);
        
        // Actualizar LocalStorage con los datos del servidor
        localStorage.setItem(TASKS_KEY, JSON.stringify(remoteData.tasks || []));
        localStorage.setItem(DELETED_TASKS_KEY, JSON.stringify(remoteData.deletedTasks || []));
        localStorage.setItem(MANAGEMENT_KEY, JSON.stringify(remoteData.managementData || {}));
        
        // Actualizar la versión local
        localStorage.setItem(VERSION_KEY, version.toString());
        localDataVersion = version;
        
        console.log("[Collab] Datos locales actualizados desde el servidor.");
        // Notificar a la aplicación React que los datos han cambiado
        triggerDataUpdate(remoteData);
    }

    /**
     * Obtiene la última versión de los datos del servidor.
     */
    async function fetchRemoteData() {
        triggerStatusChange('syncing');
        try {
            const { data, error } = await supabase
                .from(SYNC_TABLE)
                .select('data, version')
                .order('version', { ascending: false })
                .limit(1)
                .single();

            if (error && error.code !== 'PGRST116') { // PGRST116 = "single() row not found"
                console.error("[Collab] Error al obtener datos remotos:", error);
                triggerStatusChange('error');
                return;
            }
            
            // Si la base de datos está vacía, sube los datos locales como la versión inicial.
            if (!data) {
                console.log("[Collab] La base de datos en la nube está vacía. Subiendo datos locales como versión inicial.");
                await syncToRemote();
                triggerStatusChange('connected');
                return;
            }
            
            // Si la versión del servidor es más nueva, procesa los datos.
            if (data.version > localDataVersion) {
                processRemoteData(data.data, data.version);
            }
            triggerStatusChange('connected');

        } catch (err) {
            console.error('[Collab] Fallo en la obtención de datos remotos:', err);
            triggerStatusChange('error');
        }
    }

    /**
     * Sube el estado actual de los datos locales al servidor.
     */
    async function syncToRemote() {
        triggerStatusChange('syncing');
        try {
            // Obtener la versión más reciente del servidor para evitar conflictos
            const { data: latestVersionData, error: versionError } = await supabase
                .from(SYNC_TABLE)
                .select('version')
                .order('version', { ascending: false })
                .limit(1)
                .single();

            if (versionError && versionError.code !== 'PGRST116') {
                console.error("[Collab] No se pudo obtener la última versión antes de sincronizar:", versionError);
                triggerStatusChange('error');
                return;
            }
            
            const latestVersion = latestVersionData ? latestVersionData.version : 0;
            const newVersion = latestVersion + 1;
            
            const localData = {
                tasks: JSON.parse(localStorage.getItem(TASKS_KEY) || '[]'),
                deletedTasks: JSON.parse(localStorage.getItem(DELETED_TASKS_KEY) || '[]'),
                managementData: JSON.parse(localStorage.getItem(MANAGEMENT_KEY) || '{}')
            };
            
            const { error } = await supabase.from(SYNC_TABLE).insert([{ data: JSON.stringify(localData), version: newVersion }]);
            
            if (error) {
                console.error('[Collab] Error al subir datos a la nube:', error);
                triggerStatusChange('error');
                // Si hay un error (ej. clave de versión duplicada), vuelve a buscar los datos más recientes
                if (error.code === '23505') { // duplicate key value
                   console.log('[Collab] Conflicto de versión detectado. Obteniendo los datos más recientes...');
                   fetchRemoteData();
                }
                return;
            }
            
            localStorage.setItem(VERSION_KEY, newVersion.toString());
            localDataVersion = newVersion;
            console.log(`[Collab] Datos locales sincronizados con éxito a la nube como versión ${newVersion}.`);
            triggerStatusChange('connected');

        } catch (err) {
            console.error('[Collab] Fallo al sincronizar con la nube:', err);
            triggerStatusChange('error');
        }
    }

    /**
     * Se suscribe a los cambios en la base de datos en tiempo real.
     */
    function subscribeToRemoteChanges() {
        const channel = supabase.channel('collaboration_channel');
        channel
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: SYNC_TABLE }, (payload) => {
                console.log('[Collab] ¡Nuevo cambio detectado en tiempo real!');
                const newVersion = payload.new.version;
                if (newVersion > localDataVersion) {
                    processRemoteData(payload.new.data, newVersion);
                }
            })
            .subscribe((status) => {
                 if (status === 'SUBSCRIBED') {
                    console.log('[Collab] Conectado al canal de cambios en tiempo real.');
                 }
            });
    }
    
    /**
     * Función de sondeo para verificar cambios si la conexión en tiempo real falla.
     */
    async function pollForChanges() {
        try {
            const { data, error } = await supabase
                .from(SYNC_TABLE)
                .select('version')
                .order('version', { ascending: false })
                .limit(1)
                .single();

            if (error && error.code !== 'PGRST116') {
                console.warn("[Collab Polling] No se pudo verificar la versión:", error.message);
                return; 
            }

            if (data && data.version > localDataVersion) {
                console.log("[Collab Polling] Se detectó una nueva versión. Obteniendo datos...");
                fetchRemoteData();
            }
        } catch (err) {
            console.warn("[Collab Polling] Error durante el sondeo:", err.message);
        }
    }

    function triggerStatusChange(status) { statusCallbacks.forEach(cb => cb(status)); }
    function triggerDataUpdate(data) { dataCallbacks.forEach(cb => cb(data)); }

    /**
     * API Global para la aplicación React
     */
    window.Collaboration = {
        /**
         * Inicializa la colaboración y registra los callbacks.
         * @param {object} callbacks - Objeto con callbacks.
         * @param {function} callbacks.onStatusChange - Se llama cuando cambia el estado de la conexión.
         * @param {function} callbacks.onDataUpdate - Se llama cuando se reciben nuevos datos del servidor.
         */
        setup: (callbacks) => {
            if (callbacks.onStatusChange) statusCallbacks.push(callbacks.onStatusChange);
            if (callbacks.onDataUpdate) dataCallbacks.push(callbacks.onDataUpdate);
        },

        /**
         * Notifica al módulo de colaboración que los datos locales han cambiado y deben ser sincronizados.
         */
        sync: () => {
            // Se usa un pequeño retardo para agrupar múltiples cambios locales rápidos en una sola sincronización
            clearTimeout(window.Collaboration._syncTimeout);
            window.Collaboration._syncTimeout = setTimeout(syncToRemote, 500);
        },
        
        _syncTimeout: null
    };
    
    /**
     * Inicializa el módulo.
     */
    // --- 最终版本的 init 函数 ---
    async function init() {
        const savedVersion = localStorage.getItem(VERSION_KEY);
        localDataVersion = savedVersion ? parseInt(savedVersion, 10) : 0;
        
        // 确保 supabase 客户端在第一时间被创建并挂载到 window 对象上
        window.supabase = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

        // 等待首次从云端获取数据或将本地数据同步到云端的操作完成
        await fetchRemoteData(); 

        // 在首次同步完成后，再开始监听后续的实时变化和轮询
        subscribeToRemoteChanges();
        setInterval(pollForChanges, POLLING_INTERVAL);

        // 现在，在确保一切准备就绪后，才启动React应用
        console.log("协作模块初始化完成，正在启动主应用...");
        if (window.startApp) {
            window.startApp();
        }
    }
    
    // Ejecutar init cuando el DOM esté listo
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();

