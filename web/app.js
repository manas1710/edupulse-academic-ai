// ============================================================================
// WEB DEPLOYMENT BRIDGE (Polyfills window.pywebview.api in standard browsers)
// ============================================================================
(function initEduPulseWebBridge() {
    if (typeof window !== 'undefined' && (window.__EDUPULSE_WEB_MODE__ || (!window.pywebview && window.location.protocol.startsWith('http')))) {
        const pickAndUploadFile = (accept, action, extraData = {}) => {
            return new Promise((resolve) => {
                const input = document.createElement('input');
                input.type = 'file';
                if (accept) input.accept = accept;
                input.style.display = 'none';
                document.body.appendChild(input);

                let settled = false;
                const cleanup = () => {
                    window.removeEventListener('focus', onWindowFocus);
                    if (input.parentNode) input.parentNode.removeChild(input);
                };
                const onWindowFocus = () => {
                    setTimeout(() => {
                        if (!settled && (!input.files || input.files.length === 0)) {
                            settled = true;
                            cleanup();
                            resolve({ status: 'cancelled' });
                        }
                    }, 600);
                };
                window.addEventListener('focus', onWindowFocus);

                input.addEventListener('change', async () => {
                    settled = true;
                    const file = input.files && input.files[0];
                    cleanup();
                    if (!file) {
                        resolve({ status: 'cancelled' });
                        return;
                    }
                    try {
                        const formData = new FormData();
                        formData.append('file', file);
                        formData.append('action', action);
                        Object.entries(extraData).forEach(([k, v]) => {
                            if (v !== undefined && v !== null) formData.append(k, String(v));
                        });
                        const resp = await fetch('/api/upload', { method: 'POST', body: formData });
                        const data = await resp.json();
                        resolve(data);
                    } catch (err) {
                        resolve({ status: 'error', message: err.message || String(err) });
                    }
                });

                input.click();
            });
        };

        const triggerBrowserDownload = (downloadUrl, filename) => {
            const a = document.createElement('a');
            a.href = downloadUrl;
            if (filename) a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
        };

        const apiProxy = new Proxy({}, {
            get(_target, prop) {
                if (prop === 'then' || typeof prop === 'symbol') return undefined;
                return async (...args) => {
                    if (prop === 'choose_file' && args.length === 0) {
                        return await pickAndUploadFile('.pdf,.docx,.pptx,.txt', 'choose_file');
                    }
                    if (prop === 'upload_faculty_photo' && args.length <= 1) {
                        return await pickAndUploadFile('image/*', 'upload_faculty_photo', { faculty_id: args[0] });
                    }
                    if (prop === 'bulk_import_students' && args.length <= 1) {
                        return await pickAndUploadFile('.csv', 'bulk_import_students', { faculty_id: args[0] });
                    }
                    if (prop === 'restore_database' && args.length === 0) {
                        return await pickAndUploadFile('.db,.sqlite,.sqlite3', 'restore_database');
                    }
                    if (prop === 'open_file' || prop === 'open_folder') {
                        const filePath = String(args[0] || '');
                        const baseName = filePath.split(/[\\/]/).pop();
                        if (baseName) {
                            triggerBrowserDownload(`/api/download/${encodeURIComponent(baseName)}`, baseName);
                            return { status: 'success' };
                        }
                    }

                    const resp = await fetch(`/api/rpc/${encodeURIComponent(String(prop))}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ args })
                    });
                    const result = await resp.json();
                    if (result && result.status === 'success' && result.download_url) {
                        triggerBrowserDownload(result.download_url, result.filename);
                    }
                    return result;
                };
            }
        });

        window.pywebview = {
            isWebMode: true,
            api: apiProxy
        };
    }
})();

// Non-reactive Chart Registry outside Alpine to prevent circular Proxy recursion and RangeError: Maximum call stack size exceeded
const appChartStore = {
    cohort: null,
    distribution: null,
    student: null
};

document.addEventListener('alpine:init', () => {
    Alpine.data('appData', () => ({
        isLoggedIn: false,
        selectedFacultyId: '',
        loginPassword: '',
        currentFaculty: null,
        faculties: [],
        newFacultyName: '',
        newFacultySubject: '',
        newFacultyPassword: '',
        isAddingFaculty: false,
        loginError: '',
        addFacultyError: '',
        
        showAddStudent: false,
        newStudentName: '',
        newStudentRoll: '',
        addStudentError: '',

        // Past Students & Delete Modal
        viewMode: 'active', // 'active' or 'past'
        pastStudents: [],
        showDeleteModal: false,
        studentToDelete: null,
        deleteRemark: '',

        // Dashboard Filter
        showFilter: false,
        filterQuery: '',
        filterStatus: 'all',

        // Profile
        showProfileMenu: false,

        // Toast Notification System
        toast: { visible: false, title: '', message: '', type: 'success', filePath: '' },
        _toastTimer: null,

        showToast(message, type = 'success', filePath = '', customTitle = '') {
            if (this._toastTimer) clearTimeout(this._toastTimer);
            const defaultTitle = type === 'error' ? 'Action Required' : (type === 'info' ? 'Information' : 'Success');
            this.toast = {
                visible: true,
                title: customTitle || defaultTitle,
                message: String(message || ''),
                type: type || 'success',
                filePath: filePath || ''
            };
            this._toastTimer = setTimeout(() => {
                this.toast.visible = false;
            }, 5500);
        },

        async openToastFile() {
            if (window.pywebview && this.toast.filePath) {
                await pywebview.api.open_file(this.toast.filePath);
            }
        },

        async openToastFolder() {
            if (window.pywebview && this.toast.filePath) {
                await pywebview.api.open_folder(this.toast.filePath);
            }
        },

        isLowAttendance(attStr) {
            const raw = String(attStr || '85').replace('%', '').trim();
            const n = parseFloat(raw);
            return !isNaN(n) && n < 75;
        },

        get lowAttendanceCount() {
            return (this.students || []).filter(s => this.isLowAttendance(s.attendance)).length;
        },

        // Marks & Record Entry
        showBatchMarksModal: false,
        batchAssignmentTitle: 'Assignment 1',
        batchMaxMarks: 100,
        batchRecords: [],
        batchError: '',
        
        // Attendance Management
        showAttendanceModal: false,
        attendanceRecords: [],

        showEditRecordModal: false,
        editingRecord: {
            id: null,
            name: '',
            roll: '',
            attendanceNum: 85,
            attendance: '85%',
            status: 'On-time',
            score: '',
            maxMarks: 100,
            assignmentMode: 'existing',
            selectedAssignmentTitle: '',
            assignmentTitle: '',
            customAssignmentTitle: '',
            insight: ''
        },
        editRecordError: '',

        // Dashboard KPI Breakdown Modal & Filter
        showKpiModal: false,
        activeKpiCategory: 'at_risk', // 'avg', 'passing', 'at_risk', 'mastery', 'low_attendance'
        dashboardKpiFilter: 'all', // 'all', 'passing', 'at_risk', 'mastery', 'low_attendance'
        rosterSortBy: 'roll', // 'roll', 'name', 'score_desc', 'score_asc', 'att_desc', 'att_asc'
        progressSortBy: 'roll',

        // Manage Students Directory Filter & Sort
        directorySearchQuery: '',
        directorySortBy: 'roll',
        directoryFilter: 'all', // 'all', 'low_attendance', 'at_risk'

        openKpiBreakdown(category) {
            this.activeKpiCategory = category;
            this.dashboardKpiFilter = category === 'avg' ? 'all' : category;
            this.showKpiModal = true;
        },

        matchesKpiCategory(student, category) {
            if (!student) return false;
            if (category === 'low_attendance') {
                return this.isLowAttendance(student.attendance);
            }
            const avgNum = (student.overall_average !== '--' && student.overall_average !== undefined && student.overall_average !== '')
                ? Number(student.overall_average)
                : (student.latest !== '--' && student.latest !== undefined && student.latest !== '' ? Number(student.latest) : null);

            if (category === 'avg' || category === 'all') {
                return true;
            }
            if (avgNum === null || isNaN(avgNum)) return false;
            if (category === 'passing') {
                return avgNum >= 50;
            }
            if (category === 'at_risk') {
                return avgNum < 50;
            }
            if (category === 'mastery') {
                return avgNum >= 75;
            }
            return true;
        },

        sortStudentList(list, sortKey) {
            const arr = [...(list || [])];
            const getScore = (s) => {
                if (s.overall_average !== undefined && s.overall_average !== '--' && s.overall_average !== '' && s.total_assessments !== 0) {
                    const n = Number(s.overall_average);
                    if (!isNaN(n)) return n;
                }
                if (s.latest !== undefined && s.latest !== '--' && s.latest !== '') {
                    const n = Number(s.latest);
                    if (!isNaN(n)) return n;
                }
                return null;
            };
            const getAtt = (s) => {
                const raw = String(s.attendance || '0').replace('%', '').trim();
                const n = parseFloat(raw);
                return isNaN(n) ? 0 : n;
            };

            arr.sort((a, b) => {
                if (sortKey === 'name') {
                    return String(a.name || '').localeCompare(String(b.name || ''));
                }
                if (sortKey === 'score_desc') {
                    const sa = getScore(a), sb = getScore(b);
                    if (sa === null && sb === null) return 0;
                    if (sa === null) return 1;
                    if (sb === null) return -1;
                    return sb - sa;
                }
                if (sortKey === 'score_asc') {
                    const sa = getScore(a), sb = getScore(b);
                    if (sa === null && sb === null) return 0;
                    if (sa === null) return 1;
                    if (sb === null) return -1;
                    return sa - sb;
                }
                if (sortKey === 'att_desc') {
                    return getAtt(b) - getAtt(a);
                }
                if (sortKey === 'att_asc') {
                    return getAtt(a) - getAtt(b);
                }
                // Default: 'roll'
                return String(a.roll || '').localeCompare(String(b.roll || ''), undefined, { numeric: true, sensitivity: 'base' });
            });
            return arr;
        },

        get kpiModalStudents() {
            return (this.students || []).filter(s => this.matchesKpiCategory(s, this.activeKpiCategory));
        },

        get filteredStudents() {
            let result = this.students || [];
            if (this.dashboardKpiFilter && this.dashboardKpiFilter !== 'all') {
                result = result.filter(s => this.matchesKpiCategory(s, this.dashboardKpiFilter));
            }
            if (this.filterStatus !== 'all') {
                result = result.filter(s => s.status === this.filterStatus);
            }
            if (this.filterQuery.trim()) {
                const q = this.filterQuery.toLowerCase();
                result = result.filter(s => 
                    s.name.toLowerCase().includes(q) || 
                    s.roll.toLowerCase().includes(q)
                );
            }
            return this.sortStudentList(result, this.rosterSortBy);
        },

        get filteredDirectoryStudents() {
            let list = this.students || [];
            if (this.directoryFilter === 'low_attendance') {
                list = list.filter(s => this.isLowAttendance(s.attendance));
            } else if (this.directoryFilter === 'at_risk') {
                list = list.filter(s => this.matchesKpiCategory(s, 'at_risk'));
            }
            if (this.directorySearchQuery && this.directorySearchQuery.trim()) {
                const q = this.directorySearchQuery.toLowerCase().trim();
                list = list.filter(s =>
                    String(s.name || '').toLowerCase().includes(q) ||
                    String(s.roll || '').toLowerCase().includes(q)
                );
            }
            return this.sortStudentList(list, this.directorySortBy);
        },

        get filteredPastStudents() {
            let list = this.pastStudents || [];
            if (this.directorySearchQuery && this.directorySearchQuery.trim()) {
                const q = this.directorySearchQuery.toLowerCase().trim();
                list = list.filter(s =>
                    String(s.name || '').toLowerCase().includes(q) ||
                    String(s.roll || '').toLowerCase().includes(q) ||
                    String(s.remark || '').toLowerCase().includes(q)
                );
            }
            return list;
        },

        // Student Progress & Longitudinal Analytics
        progressData: { cohort: { timeline: [], distribution: {} }, assignments: [], students: [] },
        selectedStudentForProgress: null,
        selectedStudentId: '',
        progressSearchQuery: '',
        progressFilter: 'all',
        progressViewMode: 'cohort', // 'cohort' or 'student'
        showProgressKpiModal: false,
        activeProgressKpi: 'avg', // 'avg', 'assessments', 'mastery', 'at_risk'

        openProgressKpiBreakdown(category) {
            this.activeProgressKpi = category;
            if (category === 'avg') {
                this.progressFilter = 'all';
            } else if (category === 'mastery') {
                this.progressFilter = 'mastery';
            } else if (category === 'at_risk') {
                this.progressFilter = 'at_risk';
            }
            this.showProgressKpiModal = true;
        },

        get needsAttentionCount() {
            if (!this.progressData || !this.progressData.students) return 0;
            return this.progressData.students.filter(s => s.total_assessments > 0 && (s.overall_average < 50 || s.growth_pts <= -10)).length;
        },

        get progressKpiModalStudents() {
            if (!this.progressData || !this.progressData.students) return [];
            const list = this.progressData.students;
            if (this.activeProgressKpi === 'mastery') {
                return list.filter(s => s.total_assessments > 0 && s.overall_average >= 75);
            }
            if (this.activeProgressKpi === 'at_risk') {
                return list.filter(s => s.total_assessments > 0 && (s.overall_average < 50 || s.growth_pts <= -10));
            }
            return list;
        },

        get filteredProgressStudents() {
            if (!this.progressData || !this.progressData.students) return [];
            let list = this.progressData.students;
            if (this.progressFilter === 'improving') {
                list = list.filter(s => s.total_assessments > 0 && s.growth_pts > 0);
            } else if (this.progressFilter === 'declining') {
                list = list.filter(s => s.total_assessments > 0 && s.growth_pts < 0);
            } else if (this.progressFilter === 'at_risk') {
                list = list.filter(s => s.total_assessments > 0 && (s.overall_average < 50 || s.growth_pts <= -10));
            } else if (this.progressFilter === 'mastery') {
                list = list.filter(s => s.total_assessments > 0 && s.overall_average >= 75);
            }

            if (this.progressSearchQuery && this.progressSearchQuery.trim()) {
                const q = this.progressSearchQuery.toLowerCase().trim();
                list = list.filter(s => s.name.toLowerCase().includes(q) || s.roll.toLowerCase().includes(q));
            }
            return this.sortStudentList(list, this.progressSortBy);
        },

        currentTab: 'dashboard',
        apiKey: '',
        chapter: 'Chapter 1: Intro to AI',
        numQuestions: 5,
        difficulty: 'Easy',
        mcqGenerationMode: 'auto', // 'auto' (Gemini AI + Offline Fallback) or 'offline' (Offline Smart Engine)
        filePath: '',
        fileName: 'No file selected',
        syllabusSourceMode: 'file', // 'file' or 'text'
        customSyllabusText: '',
        examMarksPerQuestion: 2,
        examDuration: '60 Mins',
        isGenerating: false,
        genError: '',
        stats: { avg_score: '--', passing_rate: '--', at_risk: '--', mastery: '--' },
        students: [],
        subjects: [],
        mcqs: [],
        editingMcqIndex: -1,
        editingMcqForm: { question: '', options: ['', '', '', ''], answer: '', explanation: '' },
        mcqEditForm: { question: '', options: ['', '', '', ''], answer: '', explanation: '' },
        showAddMcqModal: false,
        customMcqForm: { question: '', optA: '', optB: '', optC: '', optD: '', answer: '', explanation: '' },
        newMcqForm: { question: '', options: ['', '', '', ''], answerIndex: 0 },
        questionBankPapers: [],
        savedPapers: [],
        showQuestionBankModal: false,
        questionBankSearch: '',
        questionBankDiffFilter: 'all',

        get filteredQuestionBankPapers() {
            let list = this.questionBankPapers || [];
            if (this.questionBankDiffFilter && this.questionBankDiffFilter !== 'all') {
                list = list.filter(p => String(p.difficulty || 'Moderate').toLowerCase() === this.questionBankDiffFilter.toLowerCase());
            }
            if (this.questionBankSearch && this.questionBankSearch.trim()) {
                const q = this.questionBankSearch.toLowerCase().trim();
                list = list.filter(p =>
                    String(p.title || '').toLowerCase().includes(q) ||
                    String(p.chapter || '').toLowerCase().includes(q)
                );
            }
            return list;
        },

        isExporting: false,
        exportSuccess: false,
        exportError: '',
        exportedPath: '',
        exportedFileName: '',
        exportFormat: '',
        exportIncludeAnswers: true,
        isDownloadingReport: false,
        isExportingCsv: false,
        isExportingStudentCard: false,
        isExportingStudentReport: false,
        editingAssignmentId: null,
        showEditStudentModal: false,
        editingStudentForm: { id: null, name: '', roll: '' },
        editStudentError: '',
        isBackingUpDb: false,
        isRestoringDb: false,
        lastBackupFileName: '',

        // Faculty Security & API Key Settings
        passwordForm: { currentPassword: '', newPassword: '', confirmPassword: '', current: '', newPass: '', confirm: '' },
        passwordError: '',
        passwordSuccess: '',
        apiKeyInput: '',
        profileApiKey: '',
        isSavingApiKey: false,
        showApiKeyText: false,

        facultyDetails: {
            id: null,
            name: 'Manas Ahiray',
            subject: 'Data Science',
            email: 'manas.ahiray@college.edu',
            department: 'Computer Science & Engineering',
            designation: 'Assistant Professor & Course Coordinator',
            course_code: 'CS301',
            credits: 4,
            semester: 'Semester V (2026)',
            syllabus_units: 'Unit 1: Foundations of Data Science & Python\nUnit 2: Data Wrangling & Exploratory Analysis\nUnit 3: Machine Learning & Predictive Modeling\nUnit 4: Big Data Frameworks (Hadoop & Spark)\nUnit 5: Model Deployment & Data Ethics',
            syllabus_file: 'Data Science.pdf',
            syllabus_path: '',
            profile_photo: '',
            api_key: '',
            total_students: 0,
            total_assignments: 0,
            avg_score: '--',
            avg_attendance: '--'
        },
        showEditFacultyModal: false,
        editFacultyForm: {},
        editFacultyError: '',

        get activeFacultyId() {
            return (this.currentFaculty && this.currentFaculty.id) || this.selectedFacultyId || null;
        },

        get parsedSyllabusUnits() {
            if (!this.facultyDetails || !this.facultyDetails.syllabus_units) return [];
            return this.facultyDetails.syllabus_units.split('\n').map(u => u.trim()).filter(Boolean);
        },

        generateOfflineAvatar(name, bgHex = '#4f46e5') {
            const clean = String(name || 'User').trim();
            const parts = clean.split(/\s+/).filter(Boolean);
            let initials = 'U';
            if (parts.length >= 2) {
                initials = (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
            } else if (parts.length === 1 && parts[0].length > 0) {
                initials = parts[0].slice(0, 2).toUpperCase();
            }
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" fill="${bgHex}"/><text x="50%" y="52%" dominant-baseline="middle" text-anchor="middle" fill="#ffffff" font-family="Inter, Arial, sans-serif" font-weight="700" font-size="48">${initials}</text></svg>`;
            return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
        },

        getStudentAvatar(name) {
            const palette = ['#4f46e5', '#0d9488', '#7c3aed', '#2563eb', '#db2777', '#059669', '#d97706'];
            const str = String(name || 'Student');
            let hash = 0;
            for (let i = 0; i < str.length; i++) {
                hash = str.charCodeAt(i) + ((hash << 5) - hash);
            }
            const color = palette[Math.abs(hash) % palette.length];
            return this.generateOfflineAvatar(str, color);
        },

        resetSessionState() {
            this.filePath = '';
            this.fileName = '';
            this.mcqs = [];
            this.editingMcqIndex = -1;
            this.questionBankPapers = [];
            this.savedPapers = [];
            this.dashboardKpiFilter = 'all';
            this.progressFilter = 'all';
            this.filterQuery = '';
            this.progressSearch = '';
            this.selectedStudentForProgress = null;
            this.selectedStudentId = null;
            this.showProfileMenu = false;
            this.currentTab = 'dashboard';
        },

        logout() {
            this.isLoggedIn = false;
            this.currentFaculty = null;
            this.loginPassword = '';
            this.resetSessionState();
        },

        async login() {
            this.loginError = '';
            if(!this.selectedFacultyId) { this.loginError = "Please select a profile."; return; }
            if(!this.loginPassword) { this.loginError = "Please enter your password."; return; }
            
            if(window.pywebview) {
                const res = await pywebview.api.verify_login(this.selectedFacultyId, this.loginPassword);
                if(res.status === 'success') {
                    this.resetSessionState();
                    this.currentFaculty = this.faculties.find(f => f.id == this.selectedFacultyId);
                    this.chapter = this.currentFaculty.subject; // default the generator to their subject
                    this.isLoggedIn = true;
                    this.loginPassword = ''; // clear password
                    await this.loadFacultyProfile();
                    await this.loadDashboard();
                    await this.loadProgressAnalytics();
                    await this.loadPastStudents();
                    this.showToast(`Welcome back, ${this.currentFaculty.name}!`, 'success');
                } else {
                    this.loginError = res.message;
                }
            } else {
                // Browser fallback
                this.resetSessionState();
                this.currentFaculty = this.faculties.find(f => f.id == this.selectedFacultyId);
                this.isLoggedIn = true;
            }
        },

        init() {
            if (window.pywebview && window.pywebview.isWebMode) {
                this.loadFaculties();
                this.loadDashboard();
                this.loadProgressAnalytics();
                return;
            }
            // pywebview injects window.pywebview
            window.addEventListener('pywebviewready', () => {
                this.loadFaculties();
                this.loadDashboard();
                this.loadProgressAnalytics();
            });
            // Fallback for browser dev
            setTimeout(() => {
                if (this.faculties.length === 0) {
                    this.loadFaculties();
                    this.loadDashboard();
                    this.loadProgressAnalytics();
                }
            }, 500);
        },

        async loadFaculties() {
            if(window.pywebview) {
                this.faculties = await pywebview.api.get_faculties();
                this.subjects = this.faculties; // Map subjects directly from faculties for now
            }
        },

        async loadDashboard() {
            if(window.pywebview) {
                const fid = this.activeFacultyId;
                this.stats = await pywebview.api.get_dashboard_stats(fid);
                this.students = await pywebview.api.get_students(fid);
            } else {
                this.stats = { avg_score: "0", passing_rate: "0", at_risk: 0, mastery: "0" };
            }
        },

        async downloadClassReport() {
            if (!window.pywebview || this.isDownloadingReport) return;
            this.isDownloadingReport = true;
            try {
                const fid = this.activeFacultyId;
                const res = await pywebview.api.download_dashboard_report(fid);
                if (res && res.status === 'success') {
                    this.showToast(`Class Report PDF saved to Desktop: ${res.filename}`, 'success', res.path);
                } else if (res && res.message) {
                    this.showToast('Failed to generate report: ' + res.message, 'error');
                }
            } catch (e) {
                this.showToast('Error exporting report: ' + (e.message || String(e)), 'error');
            } finally {
                this.isDownloadingReport = false;
            }
        },

        async exportGradebookCsv() {
            if (!window.pywebview || this.isExportingCsv) return;
            this.isExportingCsv = true;
            try {
                const fid = this.activeFacultyId;
                const res = await pywebview.api.export_gradebook_csv(fid);
                if (res && res.status === 'success') {
                    this.showToast(`CSV Gradebook saved to Desktop: ${res.filename}`, 'success', res.path);
                } else {
                    this.showToast((res && res.message) || 'Failed to export CSV gradebook.', 'error');
                }
            } catch (e) {
                this.showToast('Error exporting CSV: ' + (e.message || String(e)), 'error');
            } finally {
                this.isExportingCsv = false;
            }
        },

        async downloadSampleCsv() {
            if (!window.pywebview) return;
            try {
                const res = await pywebview.api.download_sample_csv();
                if (res && res.status === 'success') {
                    this.showToast(`Sample CSV Template saved to Desktop: ${res.filename}`, 'success', res.path);
                } else {
                    this.showToast((res && res.message) || 'Failed to save sample CSV.', 'error');
                }
            } catch (e) {
                this.showToast('Error saving sample CSV: ' + (e.message || String(e)), 'error');
            }
        },

        async downloadStudentReportCard(studentId = null) {
            const targetId = studentId || (this.selectedStudentForProgress && this.selectedStudentForProgress.id);
            if (!window.pywebview || !targetId || this.isExportingStudentCard) return;
            this.isExportingStudentCard = true;
            this.isExportingStudentReport = true;
            try {
                const fid = this.activeFacultyId;
                const res = await pywebview.api.export_student_report_card(targetId, fid);
                if (res && res.status === 'success') {
                    this.showToast(`Student Report Card saved to Desktop: ${res.filename}`, 'success', res.path);
                } else {
                    this.showToast((res && res.message) || 'Failed to export report card.', 'error');
                }
            } catch (e) {
                this.showToast('Error exporting report card: ' + (e.message || String(e)), 'error');
            } finally {
                this.isExportingStudentCard = false;
                this.isExportingStudentReport = false;
            }
        },

        async addNewFaculty() {
            this.addFacultyError = '';
            if(!this.newFacultyName || !this.newFacultySubject || !this.newFacultyPassword) {
                this.addFacultyError = "Please fill all fields, including the password.";
                return;
            }
            if(window.pywebview) {
                const res = await pywebview.api.add_faculty(this.newFacultyName, this.newFacultySubject, this.newFacultyPassword);
                if(res.status === 'success') {
                    this.isAddingFaculty = false;
                    this.newFacultyName = '';
                    this.newFacultySubject = '';
                    this.newFacultyPassword = '';
                    await this.loadFaculties();
                    this.showToast('New faculty profile created!', 'success');
                } else {
                    this.addFacultyError = res.message;
                }
            }
        },

        async addStudent(keepOpen = false) {
            this.addStudentError = '';
            if(!this.newStudentName || !this.newStudentRoll) {
                this.addStudentError = "Please fill out both the Name and Roll Number.";
                return;
            }
            
            if(window.pywebview) {
                const fid = this.activeFacultyId;
                const res = await pywebview.api.add_student(this.newStudentName, this.newStudentRoll, fid);
                if(res.status === 'success') {
                    const addedName = this.newStudentName;
                    this.newStudentName = '';
                    this.newStudentRoll = '';
                    if(!keepOpen) {
                        this.showAddStudent = false;
                    }
                    
                    // Refresh the student list immediately
                    await this.loadDashboard();
                    await this.loadPastStudents();
                    await this.loadProgressAnalytics();
                    this.showToast(`Added ${addedName} to active roster.`, 'success');
                } else {
                    this.addStudentError = res.message;
                }
            }
        },

        openEditStudentModal(student) {
            this.editStudentError = '';
            this.editingStudentForm = {
                id: student.id,
                name: student.name,
                roll: student.roll
            };
            this.showEditStudentModal = true;
        },

        async saveEditStudent() {
            this.editStudentError = '';
            if (!this.editingStudentForm.name || !this.editingStudentForm.name.trim() || !this.editingStudentForm.roll || !this.editingStudentForm.roll.trim()) {
                this.editStudentError = 'Please enter both Student Name and Roll Number.';
                return;
            }
            if (window.pywebview) {
                const res = await pywebview.api.update_student_info(
                    this.editingStudentForm.id,
                    this.editingStudentForm.name,
                    this.editingStudentForm.roll
                );
                if (res && res.status === 'success') {
                    this.showEditStudentModal = false;
                    await this.loadDashboard();
                    await this.loadProgressAnalytics();
                    this.showToast('Student details updated!', 'success');
                } else {
                    this.editStudentError = (res && res.message) || 'Failed to update student.';
                }
            }
        },

        async restoreStudent(student) {
            if (!window.pywebview || !student) return;
            const res = await pywebview.api.restore_student(student.id);
            if (res && res.status === 'success') {
                await this.loadDashboard();
                await this.loadPastStudents();
                await this.loadProgressAnalytics();
                this.showToast(`${student.name} restored to active roster!`, 'success');
            } else if (res && res.message) {
                this.showToast('Error restoring student: ' + res.message, 'error');
            }
        },

        async bulkImportStudents() {
            if(window.pywebview) {
                const fid = this.activeFacultyId;
                const res = await pywebview.api.bulk_import_students(fid);
                if(res.status === 'success') {
                    await this.loadDashboard();
                    await this.loadPastStudents();
                    await this.loadProgressAnalytics();
                    const skipMsg = res.skipped > 0 ? ` (${res.skipped} duplicate Roll No skipped)` : '';
                    this.showToast(`Successfully imported ${res.count} students${skipMsg}!`, 'success');
                } else if(res.status === 'error') {
                    this.showToast("Import Error: " + res.message, 'error');
                }
            }
        },

        async adjustStudentAttendance(student, delta) {
            if (!window.pywebview || !student) return;
            const raw = String(student.attendance || '85').replace('%', '').trim();
            const curr = isNaN(parseFloat(raw)) ? 85 : parseFloat(raw);
            const nextVal = Math.min(100, Math.max(0, Math.round(curr + delta)));
            const nextStr = `${nextVal}%`;
            const res = await pywebview.api.update_student_attendance(student.id, nextStr);
            if (res && res.status === 'success') {
                student.attendance = nextStr;
                await this.loadDashboard();
                await this.loadProgressAnalytics();
                this.showToast(`Updated ${student.name}'s attendance to ${nextStr}`, 'success');
            }
        },

        async loadPastStudents() {
            if(window.pywebview) {
                const fid = this.activeFacultyId;
                this.pastStudents = await pywebview.api.get_past_students(fid);
            }
        },

        confirmDeleteStudent(student) {
            this.studentToDelete = student;
            this.deleteRemark = '';
            this.showDeleteModal = true;
        },

        async executeDeleteStudent() {
            if(!this.deleteRemark.trim()) {
                this.showToast("Please provide a remark for archiving this student.", 'error');
                return;
            }
            if(window.pywebview) {
                const res = await pywebview.api.delete_student(this.studentToDelete.id, this.deleteRemark);
                if(res.status === 'success') {
                    const archivedName = this.studentToDelete.name;
                    this.showDeleteModal = false;
                    this.studentToDelete = null;
                    // Refresh all lists & analytics
                    await this.loadDashboard();
                    await this.loadPastStudents();
                    await this.loadProgressAnalytics();
                    this.showToast(`${archivedName} moved to Past Students archive.`, 'success');
                } else if(res.status === 'error') {
                    this.showToast("Error: " + res.message, 'error');
                }
            }
        },

        openBatchMarksModal() {
            this.batchError = '';
            this.editingAssignmentId = null;
            const existingCount = (this.progressData && this.progressData.assignments) ? this.progressData.assignments.length : 0;
            this.batchAssignmentTitle = `Assignment ${existingCount + 1}`;
            this.batchMaxMarks = 100;
            this.batchRecords = this.students.map(s => ({
                student_id: s.id,
                name: s.name,
                roll: s.roll,
                status: s.status && s.status !== '--' ? s.status : 'On-time',
                score: '',
                insight: ''
            }));
            this.showBatchMarksModal = true;
        },

        async openEditAssignmentMarks(asg) {
            if (!asg) return;
            this.batchError = '';
            this.editingAssignmentId = asg.id;
            this.batchAssignmentTitle = asg.title;
            this.batchMaxMarks = asg.max_marks || 100;
            let marksMap = {};
            let statusMap = {};
            if (window.pywebview) {
                const res = await pywebview.api.get_assignment_marks(asg.id);
                if (res && res.status === 'success') {
                    marksMap = res.marks || {};
                    statusMap = res.statuses || {};
                    if (res.max_marks) {
                        this.batchMaxMarks = res.max_marks;
                    }
                }
            }
            this.batchRecords = this.students.map(s => ({
                student_id: s.id,
                name: s.name,
                roll: s.roll,
                status: statusMap[s.id] || (s.status && s.status !== '--' ? s.status : 'On-time'),
                score: marksMap[s.id] !== undefined ? marksMap[s.id] : '',
                insight: ''
            }));
            this.showProgressKpiModal = false;
            this.showBatchMarksModal = true;
        },

        async deleteAssignment(asg) {
            if (!asg || !window.pywebview) return;
            if (!confirm(`Are you sure you want to delete "${asg.title}" and all student scores recorded under it?`)) {
                return;
            }
            const res = await pywebview.api.delete_assignment(asg.id);
            if (res && res.status === 'success') {
                await this.loadDashboard();
                await this.loadProgressAnalytics();
                if (this.currentTab === 'progress') {
                    setTimeout(() => this.renderProgressCharts(), 60);
                }
                this.showToast(`Deleted "${asg.title}".`, 'success');
            } else if (res && res.message) {
                this.showToast('Failed to delete assessment: ' + res.message, 'error');
            }
        },

        async saveBatchMarks() {
            if (!this.batchAssignmentTitle.trim()) {
                this.batchError = 'Please enter an assessment / assignment title.';
                return;
            }
            const maxM = parseFloat(this.batchMaxMarks);
            if (isNaN(maxM) || maxM <= 0) {
                this.batchError = 'Maximum marks must be greater than 0.';
                return;
            }
            if(window.pywebview) {
                const fid = this.activeFacultyId;
                const res = await pywebview.api.batch_record_marks(
                    this.batchAssignmentTitle,
                    this.batchRecords,
                    fid,
                    this.editingAssignmentId,
                    maxM
                );
                if(res.status === 'success') {
                    this.showBatchMarksModal = false;
                    this.editingAssignmentId = null;
                    await this.loadDashboard();
                    await this.loadProgressAnalytics();
                    if (this.currentTab === 'progress') {
                        setTimeout(() => this.renderProgressCharts(), 60);
                    }
                    this.showToast(`Saved marks for "${this.batchAssignmentTitle}"!`, 'success');
                } else {
                    this.batchError = res.message;
                }
            }
        },

        openAttendanceModal() {
            this.attendanceRecords = this.students.map(s => {
                const rawStr = s.attendance && s.attendance !== '--' ? String(s.attendance).replace('%', '').trim() : '85';
                const numVal = isNaN(parseFloat(rawStr)) ? 85 : Math.min(100, Math.max(0, parseFloat(rawStr)));
                return {
                    student_id: s.id,
                    name: s.name,
                    roll: s.roll,
                    attendanceNum: numVal,
                    attendance: `${numVal}%`
                };
            });
            this.showAttendanceModal = true;
        },

        applyAttendancePreset(preset) {
            this.attendanceRecords = (this.attendanceRecords || []).map(r => {
                let nextVal = 85;
                if (preset === 'boost2') {
                    const curr = isNaN(parseFloat(r.attendanceNum)) ? 85 : parseFloat(r.attendanceNum);
                    nextVal = Math.min(100, Math.round((curr + 2) * 10) / 10);
                } else {
                    const parsed = parseFloat(preset);
                    nextVal = isNaN(parsed) ? 85 : Math.min(100, Math.max(0, parsed));
                }
                return {
                    ...r,
                    attendanceNum: nextVal,
                    attendance: `${nextVal}%`
                };
            });
        },

        async saveAttendanceRecords() {
            if(window.pywebview) {
                const payload = this.attendanceRecords.map(r => {
                    const num = isNaN(parseFloat(r.attendanceNum)) ? 85 : Math.min(100, Math.max(0, parseFloat(r.attendanceNum)));
                    return {
                        student_id: r.student_id,
                        attendance: `${num}%`
                    };
                });
                const res = await pywebview.api.batch_update_attendance(payload);
                if(res.status === 'success') {
                    this.showAttendanceModal = false;
                    await this.loadDashboard();
                    await this.loadProgressAnalytics();
                    this.showToast('Class attendance updated!', 'success');
                } else {
                    this.showToast("Error updating attendance: " + res.message, 'error');
                }
            }
        },

        openEditRecordModal(student) {
            this.editRecordError = '';
            const assignments = (this.progressData && this.progressData.assignments) || [];
            const hasExisting = assignments.length > 0;
            const latestAsg = hasExisting ? assignments[assignments.length - 1] : null;
            const defaultNewTitle = `Assignment ${assignments.length + 1}`;

            const rawAtt = student.attendance && student.attendance !== '--' ? String(student.attendance).replace('%', '').trim() : '85';
            const attNum = isNaN(parseFloat(rawAtt)) ? 85 : Math.min(100, Math.max(0, parseFloat(rawAtt)));

            const existingMark = (student.all_marks || []).find(m => latestAsg && (m.assignment_id === latestAsg.id || m.title === latestAsg.title));

            this.editingRecord = {
                id: student.id,
                name: student.name,
                roll: student.roll,
                attendanceNum: attNum,
                attendance: `${attNum}%`,
                status: existingMark ? (existingMark.status || 'On-time') : (student.status && student.status !== '--' ? student.status : 'On-time'),
                score: existingMark ? (existingMark.raw_score !== undefined ? existingMark.raw_score : existingMark.score) : '',
                maxMarks: existingMark ? (existingMark.max_score || 100) : (latestAsg ? (latestAsg.max_marks || 100) : 100),
                assignmentMode: hasExisting ? 'existing' : 'new',
                selectedAssignmentTitle: latestAsg ? latestAsg.title : '__new__',
                assignmentTitle: defaultNewTitle,
                customAssignmentTitle: defaultNewTitle,
                insight: student.custom_insight || '',
                autoInsight: student.auto_insight || student.insight || 'Automatic delta insight'
            };
            this.showEditRecordModal = true;
        },

        onSingleRecordAssignmentChange() {
            if (this.editingRecord.selectedAssignmentTitle === '__new__') {
                const assignments = (this.progressData && this.progressData.assignments) || [];
                this.editingRecord.assignmentMode = 'new';
                this.editingRecord.assignmentTitle = `Assignment ${assignments.length + 1}`;
                this.editingRecord.customAssignmentTitle = `Assignment ${assignments.length + 1}`;
                this.editingRecord.score = '';
                this.editingRecord.maxMarks = 100;
                return;
            }
            this.editingRecord.assignmentMode = 'existing';
            const student = (this.students || []).find(s => s.id === this.editingRecord.id);
            const assignments = (this.progressData && this.progressData.assignments) || [];
            const chosenAsg = assignments.find(a => a.title === this.editingRecord.selectedAssignmentTitle);
            if (chosenAsg) {
                this.editingRecord.maxMarks = chosenAsg.max_marks || 100;
            }
            if (student && student.all_marks) {
                const foundMark = student.all_marks.find(m => m.title === this.editingRecord.selectedAssignmentTitle);
                if (foundMark) {
                    this.editingRecord.score = foundMark.raw_score !== undefined ? foundMark.raw_score : foundMark.score;
                    this.editingRecord.maxMarks = foundMark.max_score || this.editingRecord.maxMarks || 100;
                    this.editingRecord.status = foundMark.status || this.editingRecord.status;
                } else {
                    this.editingRecord.score = '';
                }
            }
        },

        async saveSingleRecord() {
            this.editRecordError = '';
            const isNewMode = this.editingRecord.assignmentMode === 'new' || this.editingRecord.selectedAssignmentTitle === '__new__';
            const targetTitle = isNewMode
                ? (this.editingRecord.assignmentTitle || this.editingRecord.customAssignmentTitle || '').trim()
                : (this.editingRecord.selectedAssignmentTitle || '').trim();

            if (this.editingRecord.score !== '' && !targetTitle) {
                this.editRecordError = 'Please select or enter an assessment title.';
                return;
            }
            const rawAttStr = String(this.editingRecord.attendance || this.editingRecord.attendanceNum || '85').replace('%', '').trim();
            const attNum = isNaN(parseFloat(rawAttStr))
                ? 85
                : Math.min(100, Math.max(0, parseFloat(rawAttStr)));

            if(window.pywebview) {
                const fid = this.activeFacultyId;
                const res = await pywebview.api.save_student_record(
                    this.editingRecord.id,
                    `${attNum}%`,
                    this.editingRecord.status,
                    this.editingRecord.score,
                    targetTitle || 'Assessment 1',
                    this.editingRecord.insight,
                    fid,
                    this.editingRecord.maxMarks || 100
                );
                if(res.status === 'success') {
                    this.showEditRecordModal = false;
                    await this.loadDashboard();
                    await this.loadProgressAnalytics();
                    if (this.currentTab === 'progress') {
                        setTimeout(() => this.renderProgressCharts(), 60);
                    }
                    this.showToast(`Updated record for ${this.editingRecord.name}!`, 'success');
                } else {
                    this.editRecordError = res.message;
                }
            }
        },

        async saveKey() {
            if(!window.pywebview) return this.showToast("PyWebView not ready.", 'error');
            const fid = this.activeFacultyId;
            const res = await pywebview.api.set_api_key(this.apiKey, fid);
            this.showToast(res.message, res.status === 'success' ? 'success' : 'error');
        },

        async saveFacultyApiKey() {
            if (!window.pywebview || this.isSavingApiKey) return;
            this.isSavingApiKey = true;
            try {
                const fid = this.activeFacultyId;
                const keyToSave = (this.apiKeyInput || this.profileApiKey || '').trim();
                const res = await pywebview.api.save_faculty_api_key(fid, keyToSave);
                if (res && res.status === 'success') {
                    this.facultyDetails.api_key = keyToSave;
                    this.facultyDetails.has_api_key = Boolean(keyToSave);
                    this.apiKeyInput = '';
                    await this.loadFacultyProfile();
                    this.showToast('Gemini API Key saved to your faculty profile!', 'success');
                } else {
                    this.showToast((res && res.message) || 'Failed to save API key.', 'error');
                }
            } finally {
                this.isSavingApiKey = false;
            }
        },

        async changeFacultyPassword() {
            if (!window.pywebview) return;
            this.passwordError = '';
            this.passwordSuccess = '';
            const curr = this.passwordForm.currentPassword || this.passwordForm.current || '';
            const nextP = this.passwordForm.newPassword || this.passwordForm.newPass || '';
            const confP = this.passwordForm.confirmPassword || this.passwordForm.confirm || '';
            if (!curr || !nextP) {
                this.passwordError = 'Please enter both your current password and new password.';
                this.showToast(this.passwordError, 'error');
                return;
            }
            if (nextP !== confP) {
                this.passwordError = 'New password and confirmation do not match.';
                this.showToast(this.passwordError, 'error');
                return;
            }
            const fid = this.activeFacultyId;
            const res = await pywebview.api.change_faculty_password(fid, curr, nextP);
            if (res && res.status === 'success') {
                this.passwordForm = { currentPassword: '', newPassword: '', confirmPassword: '', current: '', newPass: '', confirm: '' };
                this.passwordSuccess = 'Password updated successfully!';
                this.showToast('Password updated successfully!', 'success');
            } else {
                this.passwordError = (res && res.message) || 'Failed to update password.';
                this.showToast(this.passwordError, 'error');
            }
        },

        async selectFile() {
            this.genError = '';
            if(window.pywebview) {
                const res = await pywebview.api.choose_file();
                if(res.status === 'success') {
                    this.filePath = res.path;
                    this.fileName = res.name;
                    this.syllabusSourceMode = 'file';
                    this.showToast(`Loaded syllabus file: ${res.name}`, 'success');
                } else if(res.status === 'error') {
                    this.genError = "Failed to select file: " + res.message;
                }
            }
        },

        async generateMCQs() {
            if(this.isGenerating) return;
            const customText = this.syllabusSourceMode === 'text' ? (this.customSyllabusText || '').trim() : '';
            if (this.syllabusSourceMode === 'text' && !customText) {
                this.genError = 'Please paste or enter your lecture notes / syllabus text before generating.';
                return;
            }
            this.isGenerating = true;
            this.genError = '';
            this.mcqs = [];
            this.editingMcqIndex = -1;

            try {
                if(window.pywebview) {
                    const fid = this.activeFacultyId;
                    const forceOffline = this.mcqGenerationMode === 'offline';
                    const res = await pywebview.api.generate_mcqs(
                        this.chapter,
                        this.numQuestions,
                        this.difficulty,
                        this.syllabusSourceMode === 'file' ? this.filePath : null,
                        fid,
                        customText,
                        forceOffline
                    );
                    if(res.status === 'success') {
                        this.mcqs = res.data.map(q => ({...q, selected: true}));
                        const engineLabel = res.mode === 'offline' ? 'Offline Smart Engine' : 'Gemini AI';
                        this.showToast(`Generated ${this.mcqs.length} MCQs for "${this.chapter}" (${engineLabel})!`, 'success');
                    } else {
                        this.genError = res.message;
                    }
                }
            } catch (e) {
                this.genError = "Generation failed: " + (e.message || "Please check your network and API key.");
            }
            this.isGenerating = false;
        },

        startEditMcq(idx) {
            const q = this.mcqs[idx];
            if (!q) return;
            const stripPrefix = (s) => String(s || '').trim().replace(/^(?:\([A-Da-d]\)|[A-Da-d][\.\)\:])\s*/, '');
            const opts = Array.isArray(q.options) ? q.options.map(stripPrefix) : ['', '', '', ''];
            while (opts.length < 4) opts.push('');
            const cleanCurrentAns = stripPrefix(q.answer);
            const matchedIdx = opts.findIndex(o => o && o === cleanCurrentAns);
            const answerIndex = matchedIdx >= 0 ? matchedIdx : 0;
            this.editingMcqForm = {
                question: q.question || '',
                options: opts,
                answerIndex: String(answerIndex),
                answer: opts[answerIndex] || q.answer || '',
                explanation: q.explanation || ''
            };
            this.mcqEditForm = this.editingMcqForm;
            this.editingMcqIndex = idx;
        },

        saveEditMcq(idx) {
            if (idx === null || idx === undefined || idx < 0 || !this.mcqs[idx]) return;
            const form = this.editingMcqForm || this.mcqEditForm;
            const stripPrefix = (s) => String(s || '').trim().replace(/^(?:\([A-Da-d]\)|[A-Da-d][\.\)\:])\s*/, '');
            const rawMappedOpts = (form.options || []).map(stripPrefix);
            const cleanOpts = rawMappedOpts.filter(Boolean);
            if (!form.question || !form.question.trim() || cleanOpts.length < 2) {
                this.showToast('Please provide a question and at least 2 options.', 'error');
                return;
            }
            const selIdx = Number(form.answerIndex);
            let ans = '';
            if (!isNaN(selIdx) && selIdx >= 0 && selIdx < rawMappedOpts.length && rawMappedOpts[selIdx]) {
                ans = rawMappedOpts[selIdx];
            } else {
                const cleanAnsInput = stripPrefix(form.answer);
                ans = cleanOpts.includes(cleanAnsInput) ? cleanAnsInput : cleanOpts[0];
            }
            this.mcqs[idx] = {
                ...this.mcqs[idx],
                question: form.question.trim(),
                options: cleanOpts,
                answer: ans,
                explanation: String(form.explanation || '').trim()
            };
            this.editingMcqIndex = -1;
            this.showToast(`Question #${idx + 1} updated!`, 'success');
        },

        deleteMcq(idx) {
            if (idx === null || idx === undefined || idx < 0) return;
            this.mcqs.splice(idx, 1);
            if (this.editingMcqIndex === idx) {
                this.editingMcqIndex = -1;
            }
            this.showToast('Question removed from paper.', 'success');
        },

        openAddCustomMcq() {
            this.customMcqForm = {
                question: '',
                optA: '',
                optB: '',
                optC: '',
                optD: '',
                answer: '',
                explanation: ''
            };
            this.showAddMcqModal = true;
        },

        saveCustomMcq() {
            const stripPrefix = (s) => String(s || '').trim().replace(/^(?:\([A-Da-d]\)|[A-Da-d][\.\)\:])\s*/, '');
            const qText = (this.customMcqForm.question || '').trim();
            const opts = [
                stripPrefix(this.customMcqForm.optA),
                stripPrefix(this.customMcqForm.optB),
                stripPrefix(this.customMcqForm.optC),
                stripPrefix(this.customMcqForm.optD)
            ];
            if (!qText || opts.some(o => !o)) {
                this.showToast('Please fill out the question and all 4 options.', 'error');
                return;
            }
            const cleanAnsInput = stripPrefix(this.customMcqForm.answer);
            const ans = (cleanAnsInput && opts.includes(cleanAnsInput))
                ? cleanAnsInput
                : opts[0];
            this.mcqs.push({
                question: qText,
                options: opts,
                answer: ans,
                explanation: (this.customMcqForm.explanation || '').trim(),
                selected: true
            });
            this.showAddMcqModal = false;
            this.showToast('Custom question added to paper!', 'success');
        },

        async saveCurrentPaperToBank() {
            const selected = this.mcqs.filter(q => q.selected);
            if (selected.length === 0) {
                this.showToast('Select at least one question to save to Question Bank.', 'error');
                return;
            }
            if (!window.pywebview) return;
            const fid = this.activeFacultyId;
            const title = `${this.chapter || 'Assessment'} (${this.difficulty})`;
            const res = await pywebview.api.save_question_paper(fid, title, this.chapter, this.difficulty, selected);
            if (res && res.status === 'success') {
                this.showToast(`Saved "${title}" (${selected.length} Qs) to Question Bank!`, 'success');
            } else {
                this.showToast((res && res.message) || 'Failed to save to Question Bank.', 'error');
            }
        },

        async openQuestionBank() {
            this.questionBankSearch = '';
            this.questionBankDiffFilter = 'all';
            if (window.pywebview) {
                const fid = this.activeFacultyId;
                const res = await pywebview.api.get_question_papers(fid);
                if (res && res.status === 'success') {
                    this.questionBankPapers = res.papers || [];
                    this.savedPapers = this.questionBankPapers;
                }
            }
            this.showQuestionBankModal = true;
        },

        loadPaperFromBank(paper) {
            if (!paper || !Array.isArray(paper.questions)) return;
            this.chapter = paper.chapter || paper.title || this.chapter;
            this.difficulty = paper.difficulty || 'Moderate';
            this.mcqs = paper.questions.map(q => ({ ...q, selected: true }));
            this.editingMcqIndex = -1;
            this.showQuestionBankModal = false;
            this.showToast(`Loaded "${paper.title}" (${this.mcqs.length} questions)!`, 'success');
        },

        appendPaperFromBank(paper) {
            if (!paper || !Array.isArray(paper.questions)) return;
            const existingStems = new Set(this.mcqs.map(q => String(q.question || '').trim().toLowerCase()));
            let added = 0;
            for (const q of paper.questions) {
                const stem = String(q.question || '').trim().toLowerCase();
                if (stem && !existingStems.has(stem)) {
                    this.mcqs.push({ ...q, selected: true });
                    existingStems.add(stem);
                    added += 1;
                }
            }
            this.showQuestionBankModal = false;
            this.showToast(`Appended ${added} questions from "${paper.title}" (Total: ${this.mcqs.length} Qs)!`, 'success');
        },

        async deletePaperFromBank(paperId) {
            if (!window.pywebview || !paperId) return;
            const res = await pywebview.api.delete_question_paper(paperId);
            if (res && res.status === 'success') {
                this.questionBankPapers = this.questionBankPapers.filter(p => p.id !== paperId);
                this.savedPapers = this.questionBankPapers;
                this.showToast('Removed paper from Question Bank.', 'success');
            }
        },

        toggleSelectAll() {
            const allSelected = this.mcqs.every(q => q.selected);
            this.mcqs.forEach(q => q.selected = !allSelected);
        },

        async exportDoc(format) {
            const selected = this.mcqs.filter(q => q.selected);
            this.exportError = '';
            this.exportSuccess = false;
            
            if(selected.length === 0) {
                this.exportError = "Please select at least one question to export.";
                return;
            }
            
            this.isExporting = true;
            this.exportFormat = format;

            try {
                if(window.pywebview) {
                    const fid = this.activeFacultyId;
                    const res = await pywebview.api.export_mcqs(
                        selected,
                        format,
                        this.chapter,
                        this.exportIncludeAnswers,
                        fid,
                        this.examMarksPerQuestion || 2,
                        this.examDuration || '60 Mins'
                    );
                    if(res.status === 'success') {
                        this.exportSuccess = true;
                        this.exportedPath = res.path;
                        this.exportedFileName = res.filename || (format === 'word' ? 'Document.docx' : 'Document.pdf');
                        this.showToast(`Exported ${this.exportedFileName} to Desktop!`, 'success', res.path);
                    } else {
                        this.exportError = res.message || "Failed to export document.";
                    }
                } else {
                    this.exportError = "PyWebView connection not available.";
                }
            } catch (err) {
                this.exportError = "Export error: " + (err.message || String(err));
            } finally {
                this.isExporting = false;
            }
        },

        async openExportedFile() {
            if(window.pywebview && this.exportedPath) {
                await pywebview.api.open_file(this.exportedPath);
            }
        },

        async openExportedFolder() {
            if(window.pywebview && this.exportedPath) {
                await pywebview.api.open_folder(this.exportedPath);
            }
        },

        getFacultyAvatar(size = 128) {
            const customPhoto = (this.facultyDetails && this.facultyDetails.profile_photo) || (this.currentFaculty && this.currentFaculty.profile_photo);
            if (customPhoto && customPhoto.trim().length > 0) {
                return customPhoto;
            }
            const name = (this.currentFaculty && this.currentFaculty.name) || (this.facultyDetails && this.facultyDetails.name) || 'Faculty';
            return this.generateOfflineAvatar(name, '#4f46e5');
        },

        hasCustomProfilePhoto() {
            const customPhoto = (this.facultyDetails && this.facultyDetails.profile_photo) || (this.currentFaculty && this.currentFaculty.profile_photo);
            return Boolean(customPhoto && customPhoto.trim().length > 0);
        },

        async uploadProfilePhoto() {
            if (!this.currentFaculty && this.faculties.length > 0) {
                this.currentFaculty = this.faculties[0];
            }
            if (window.pywebview && this.currentFaculty) {
                try {
                    const res = await pywebview.api.upload_faculty_photo(this.currentFaculty.id);
                    if (res && res.status === 'success' && res.profile_photo) {
                        this.facultyDetails.profile_photo = res.profile_photo;
                        this.currentFaculty.profile_photo = res.profile_photo;
                        if (this.editFacultyForm) {
                            this.editFacultyForm.profile_photo = res.profile_photo;
                        }
                        await this.loadFaculties();
                        this.showToast('Profile photo updated!', 'success');
                    } else if (res && res.status === 'error') {
                        this.showToast('Could not upload photo: ' + res.message, 'error');
                    }
                } catch (e) {
                    console.error('Error uploading faculty photo:', e);
                }
            } else {
                const fileInput = document.getElementById('facultyPhotoInput');
                if (fileInput) fileInput.click();
            }
        },

        async handlePhotoFileSelect(event) {
            const file = event.target.files && event.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async (e) => {
                const dataUrl = e.target.result;
                this.facultyDetails.profile_photo = dataUrl;
                if (this.currentFaculty) {
                    this.currentFaculty.profile_photo = dataUrl;
                }
                if (this.editFacultyForm) {
                    this.editFacultyForm.profile_photo = dataUrl;
                }
                if (window.pywebview && this.currentFaculty) {
                    await pywebview.api.save_faculty_photo_data(this.currentFaculty.id, dataUrl);
                    await this.loadFaculties();
                    this.showToast('Profile photo updated!', 'success');
                }
            };
            reader.readAsDataURL(file);
            event.target.value = '';
        },

        async removeProfilePhoto() {
            this.facultyDetails.profile_photo = '';
            if (this.currentFaculty) {
                this.currentFaculty.profile_photo = '';
            }
            if (this.editFacultyForm) {
                this.editFacultyForm.profile_photo = '';
            }
            if (window.pywebview && this.currentFaculty) {
                try {
                    await pywebview.api.save_faculty_photo_data(this.currentFaculty.id, '');
                    await this.loadFaculties();
                    this.showToast('Profile photo removed.', 'success');
                } catch (e) {
                    console.error('Error removing profile photo:', e);
                }
            }
        },

        async loadFacultyProfile() {
            if(!this.currentFaculty || !window.pywebview) return;
            try {
                const res = await pywebview.api.get_faculty_profile(this.currentFaculty.id);
                if(res.status === 'success' && res.data) {
                    this.facultyDetails = { ...this.facultyDetails, ...res.data };
                    if (res.data.profile_photo !== undefined) {
                        this.currentFaculty.profile_photo = res.data.profile_photo;
                    }
                    if (res.data.api_key !== undefined) {
                        this.profileApiKey = res.data.api_key || '';
                    }
                    if (res.data.syllabus_path) {
                        this.filePath = res.data.syllabus_path;
                        this.fileName = res.data.syllabus_file || 'Master Syllabus';
                    } else {
                        this.filePath = '';
                        this.fileName = res.data.syllabus_file || '';
                    }
                }
            } catch(e) {
                console.error("Failed to load faculty profile:", e);
            }
        },

        openEditFacultyModal() {
            if (!this.currentFaculty && this.faculties.length > 0) {
                this.currentFaculty = this.faculties[0];
            }
            if (this.currentFaculty && (!this.facultyDetails.name || !this.facultyDetails.id)) {
                this.facultyDetails.name = this.currentFaculty.name;
                this.facultyDetails.subject = this.currentFaculty.subject;
                this.facultyDetails.id = this.currentFaculty.id;
                this.facultyDetails.profile_photo = this.currentFaculty.profile_photo || this.facultyDetails.profile_photo || '';
            }
            this.editFacultyForm = JSON.parse(JSON.stringify(this.facultyDetails));
            this.editFacultyError = '';
            this.showEditFacultyModal = true;
        },

        async saveFacultyProfile() {
            if (!this.currentFaculty && this.faculties.length > 0) {
                this.currentFaculty = this.faculties[0];
            }
            if (!window.pywebview || !this.currentFaculty) {
                this.showEditFacultyModal = false;
                return;
            }
            this.editFacultyError = '';
            try {
                const res = await pywebview.api.update_faculty_profile(this.currentFaculty.id, this.editFacultyForm);
                if(res.status === 'success') {
                    await this.loadFacultyProfile();
                    if (this.facultyDetails.name) {
                        this.currentFaculty.name = this.facultyDetails.name;
                    }
                    this.currentFaculty.subject = this.facultyDetails.subject;
                    this.currentFaculty.profile_photo = this.facultyDetails.profile_photo || '';
                    this.chapter = this.facultyDetails.subject;
                    this.showEditFacultyModal = false;
                    await this.loadFaculties();
                    this.showToast('Faculty profile updated!', 'success');
                } else {
                    this.editFacultyError = res.message || 'Failed to save profile changes.';
                }
            } catch(e) {
                this.editFacultyError = 'Error saving profile: ' + (e.message || String(e));
            }
        },

        async updateMasterSyllabus() {
            if(!window.pywebview || !this.currentFaculty) return;
            try {
                const res = await pywebview.api.choose_file();
                if(res.status === 'success') {
                    this.facultyDetails.syllabus_file = res.name;
                    this.facultyDetails.syllabus_path = res.path;
                    const upRes = await pywebview.api.update_faculty_profile(this.currentFaculty.id, {
                        ...this.facultyDetails,
                        syllabus_file: res.name,
                        syllabus_path: res.path
                    });
                    const persistedPath = (upRes && upRes.syllabus_path) ? upRes.syllabus_path : res.path;
                    this.facultyDetails.syllabus_path = persistedPath;
                    this.filePath = persistedPath;
                    this.fileName = res.name;
                    this.showToast(`Master Syllabus updated: ${res.name}`, 'success');
                }
            } catch(e) {
                console.error("Error updating syllabus file:", e);
            }
        },

        launchGeneratorFromHub() {
            if(this.facultyDetails && this.facultyDetails.subject) {
                this.chapter = this.facultyDetails.subject;
            }
            if(this.facultyDetails && this.facultyDetails.syllabus_path) {
                this.filePath = this.facultyDetails.syllabus_path;
            }
            if(this.facultyDetails && this.facultyDetails.syllabus_file) {
                this.fileName = this.facultyDetails.syllabus_file;
            }
            this.syllabusSourceMode = 'file';
            this.currentTab = 'mcq';
        },

        generateForSyllabusUnit(unit) {
            if (!unit) return;
            this.chapter = String(unit).trim();
            this.syllabusSourceMode = 'file';
            if (this.facultyDetails && this.facultyDetails.syllabus_path) {
                this.filePath = this.facultyDetails.syllabus_path;
            }
            if (this.facultyDetails && this.facultyDetails.syllabus_file) {
                this.fileName = this.facultyDetails.syllabus_file;
            }
            this.currentTab = 'mcq';
            this.showToast(`Topic set to "${this.chapter}" — ready to generate MCQs!`, 'info', '', 'Syllabus Module Selected');
        },

        async backupDatabase() {
            if (!window.pywebview || this.isBackingUpDb) return;
            this.isBackingUpDb = true;
            try {
                const res = await pywebview.api.backup_database();
                if (res && res.status === 'success') {
                    this.lastBackupFileName = res.filename || '';
                    this.showToast(`Database backup saved to Desktop: ${res.filename}`, 'success', res.path, 'Backup Created');
                } else {
                    this.showToast((res && res.message) || 'Failed to backup database.', 'error');
                }
            } catch (e) {
                this.showToast('Backup error: ' + (e.message || String(e)), 'error');
            } finally {
                this.isBackingUpDb = false;
            }
        },

        async restoreDatabase() {
            if (!window.pywebview || this.isRestoringDb) return;
            this.isRestoringDb = true;
            try {
                const res = await pywebview.api.restore_database();
                if (res && res.status === 'success') {
                    await this.loadFaculties();
                    await this.loadFacultyProfile();
                    await this.loadDashboard();
                    await this.loadProgressAnalytics();
                    await this.loadPastStudents();
                    this.showToast(`Restored database from ${res.filename}!`, 'success', '', 'Database Restored');
                } else if (res && res.status === 'error') {
                    this.showToast('Restore failed: ' + res.message, 'error');
                }
            } catch (e) {
                this.showToast('Restore error: ' + (e.message || String(e)), 'error');
            } finally {
                this.isRestoringDb = false;
            }
        },

        async loadProgressAnalytics() {
            if (!window.pywebview) return;
            try {
                const fid = this.activeFacultyId;
                const res = await pywebview.api.get_progress_analytics(fid);
                if (res && res.status === 'success') {
                    this.progressData = res.data;
                    if (this.progressData.students && this.progressData.students.length > 0) {
                        if (!this.selectedStudentForProgress) {
                            this.selectedStudentForProgress = this.progressData.students[0];
                            this.selectedStudentId = this.selectedStudentForProgress.id;
                        } else {
                            const updated = this.progressData.students.find(s => String(s.id) === String(this.selectedStudentForProgress.id));
                            if (updated) {
                                this.selectedStudentForProgress = updated;
                                this.selectedStudentId = updated.id;
                            } else {
                                this.selectedStudentForProgress = this.progressData.students[0];
                                this.selectedStudentId = this.selectedStudentForProgress.id;
                            }
                        }
                    } else {
                        this.selectedStudentForProgress = null;
                        this.selectedStudentId = null;
                    }
                    if (this.currentTab === 'progress') {
                        setTimeout(() => {
                            this.renderProgressCharts();
                        }, 50);
                    }
                }
            } catch(e) {
                console.error('Error loading progress analytics:', e);
            }
        },

        async viewStudentProgress(studentId) {
            this.currentTab = 'progress';
            this.progressViewMode = 'student';
            this.selectedStudentId = studentId;
            if (!this.progressData || !this.progressData.students || this.progressData.students.length === 0) {
                await this.loadProgressAnalytics();
            }
            if (this.progressData && this.progressData.students) {
                const found = this.progressData.students.find(s => String(s.id) === String(studentId));
                if (found) {
                    this.selectedStudentForProgress = found;
                }
            }
            this.$nextTick(() => {
                setTimeout(() => {
                    this.renderStudentProgressChart();
                }, 80);
            });
        },

        setStudentViewMode(studentId = null) {
            this.progressViewMode = 'student';
            if (studentId) {
                this.selectStudentById(studentId);
            } else if (!this.selectedStudentForProgress && this.progressData && this.progressData.students && this.progressData.students.length > 0) {
                this.selectStudentById(this.progressData.students[0].id);
            } else {
                this.$nextTick(() => {
                    setTimeout(() => {
                        this.renderStudentProgressChart();
                    }, 50);
                });
            }
        },

        selectStudentById(studentId) {
            this.selectedStudentId = studentId;
            if (this.progressData && this.progressData.students) {
                const found = this.progressData.students.find(s => String(s.id) === String(studentId));
                if (found) {
                    this.selectedStudentForProgress = found;
                }
            }
            this.$nextTick(() => {
                setTimeout(() => {
                    this.renderStudentProgressChart();
                }, 40);
            });
        },

        prevStudent() {
            if (!this.progressData || !this.progressData.students || this.progressData.students.length === 0) return;
            const students = this.progressData.students;
            const idx = students.findIndex(s => String(s.id) === String(this.selectedStudentId));
            const prevIdx = idx > 0 ? idx - 1 : students.length - 1;
            this.selectStudentById(students[prevIdx].id);
        },

        nextStudent() {
            if (!this.progressData || !this.progressData.students || this.progressData.students.length === 0) return;
            const students = this.progressData.students;
            const idx = students.findIndex(s => String(s.id) === String(this.selectedStudentId));
            const nextIdx = (idx >= 0 && idx < students.length - 1) ? idx + 1 : 0;
            this.selectStudentById(students[nextIdx].id);
        },

        renderProgressCharts() {
            if (typeof Chart === 'undefined') return;
            if (this.progressViewMode === 'cohort') {
                this.renderCohortChart();
                this.renderDistributionChart();
            } else {
                this.renderStudentProgressChart();
            }
        },

        renderCohortChart() {
            if (typeof Chart === 'undefined') return;
            const canvas = document.getElementById('cohortProgressCanvas');
            if (!canvas || !this.progressData || !this.progressData.cohort) return;

            if (this.currentTab !== 'progress' || this.progressViewMode !== 'cohort') return;

            if (canvas.clientWidth === 0 || canvas.clientHeight === 0) {
                if (!this._cohortRenderRetries || this._cohortRenderRetries < 5) {
                    this._cohortRenderRetries = (this._cohortRenderRetries || 0) + 1;
                    setTimeout(() => this.renderCohortChart(), 50);
                    return;
                }
            }
            this._cohortRenderRetries = 0;

            const timeline = this.progressData.cohort.timeline || [];
            const labels = timeline.map(t => t.title);
            const averages = timeline.map(t => t.average);
            const highests = timeline.map(t => t.highest);
            const lowests = timeline.map(t => t.lowest);
            const chartLabels = labels.length ? labels : ['No Assessments Recorded'];

            let chart = appChartStore.cohort || Chart.getChart(canvas);
            if (chart && chart.ctx && chart.data && chart.data.datasets && chart.data.datasets.length >= 3) {
                try {
                    chart.data.labels = chartLabels;
                    chart.data.datasets[0].data = averages;
                    chart.data.datasets[1].data = highests;
                    chart.data.datasets[2].data = lowests;
                    chart.resize();
                    chart.update('none');
                    appChartStore.cohort = chart;
                    return;
                } catch (e) {
                    try { chart.destroy(); } catch(err) {}
                    appChartStore.cohort = null;
                }
            }

            const existing = Chart.getChart(canvas);
            if (existing) {
                try { existing.destroy(); } catch(e) {}
            }
            if (appChartStore.cohort) {
                try { appChartStore.cohort.destroy(); } catch(e) {}
                appChartStore.cohort = null;
            }

            const ctx = canvas.getContext('2d');
            if (!ctx) return;

            try {
                appChartStore.cohort = new Chart(ctx, {
                    type: 'line',
                    data: {
                        labels: chartLabels,
                        datasets: [
                            {
                                label: 'Class Average',
                                data: averages,
                                borderColor: '#4f46e5',
                                backgroundColor: 'rgba(79, 70, 229, 0.1)',
                                borderWidth: 3,
                                fill: true,
                                tension: 0.35,
                                pointRadius: 6,
                                pointHoverRadius: 8,
                                pointBackgroundColor: '#4f46e5',
                                pointBorderColor: '#ffffff',
                                pointBorderWidth: 2
                            },
                            {
                                label: 'Highest Score',
                                data: highests,
                                borderColor: '#10b981',
                                backgroundColor: 'transparent',
                                borderWidth: 2,
                                borderDash: [5, 5],
                                tension: 0.35,
                                pointRadius: 4,
                                pointBackgroundColor: '#10b981'
                            },
                            {
                                label: 'Lowest Score',
                                data: lowests,
                                borderColor: '#f43f5e',
                                backgroundColor: 'transparent',
                                borderWidth: 2,
                                borderDash: [4, 4],
                                tension: 0.35,
                                pointRadius: 4,
                                pointBackgroundColor: '#f43f5e'
                            }
                        ]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        animation: { duration: 250 },
                        plugins: {
                            legend: {
                                position: 'top',
                                labels: {
                                    font: { family: 'Plus Jakarta Sans', weight: '600', size: 11 },
                                    boxWidth: 12,
                                    padding: 15
                                }
                            },
                            tooltip: {
                                backgroundColor: '#0f172a',
                                titleFont: { family: 'Plus Jakarta Sans', weight: '700', size: 12 },
                                bodyFont: { family: 'Plus Jakarta Sans', size: 11 },
                                padding: 10,
                                cornerRadius: 8,
                                callbacks: {
                                    label: function(context) {
                                        return ` ${context.dataset.label}: ${context.parsed.y}%`;
                                    }
                                }
                            }
                        },
                        scales: {
                            y: {
                                min: 0,
                                max: 100,
                                ticks: {
                                    stepSize: 20,
                                    callback: val => val + '%',
                                    font: { family: 'Plus Jakarta Sans', size: 10 }
                                },
                                grid: { color: '#f1f5f9' }
                            },
                            x: {
                                ticks: {
                                    font: { family: 'Plus Jakarta Sans', weight: '600', size: 11 }
                                },
                                grid: { display: false }
                            }
                        }
                    }
                });
            } catch (err) {
                console.error('Error creating cohort chart:', err);
            }
        },

        renderDistributionChart() {
            if (typeof Chart === 'undefined') return;
            const canvas = document.getElementById('distributionCanvas');
            if (!canvas || !this.progressData || !this.progressData.cohort) return;

            if (this.currentTab !== 'progress' || this.progressViewMode !== 'cohort') return;

            if (canvas.clientWidth === 0 || canvas.clientHeight === 0) {
                if (!this._distRenderRetries || this._distRenderRetries < 5) {
                    this._distRenderRetries = (this._distRenderRetries || 0) + 1;
                    setTimeout(() => this.renderDistributionChart(), 50);
                    return;
                }
            }
            this._distRenderRetries = 0;

            const dist = this.progressData.cohort.distribution || {};
            const values = [
                dist.excellent || 0,
                dist.good || 0,
                dist.average || 0,
                dist.at_risk || 0
            ];

            const total = values.reduce((a, b) => a + b, 0);
            const chartData = total > 0 ? values : [0, 0, 0, 1];

            let chart = appChartStore.distribution || Chart.getChart(canvas);
            if (chart && chart.ctx && chart.data && chart.data.datasets && chart.data.datasets.length >= 1) {
                try {
                    chart.data.datasets[0].data = chartData;
                    chart.resize();
                    chart.update('none');
                    appChartStore.distribution = chart;
                    return;
                } catch (e) {
                    try { chart.destroy(); } catch(err) {}
                    appChartStore.distribution = null;
                }
            }

            const existing = Chart.getChart(canvas);
            if (existing) {
                try { existing.destroy(); } catch(e) {}
            }
            if (appChartStore.distribution) {
                try { appChartStore.distribution.destroy(); } catch(e) {}
                appChartStore.distribution = null;
            }

            const ctx = canvas.getContext('2d');
            if (!ctx) return;

            try {
                appChartStore.distribution = new Chart(ctx, {
                    type: 'doughnut',
                    data: {
                        labels: ['Mastery (≥75%)', 'Good (60-74%)', 'Passing (50-59%)', 'At-Risk (<50%)'],
                        datasets: [{
                            data: chartData,
                            backgroundColor: ['#10b981', '#6366f1', '#f59e0b', '#ef4444'],
                            borderWidth: 2,
                            borderColor: '#ffffff',
                            hoverOffset: 4
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        cutout: '68%',
                        animation: { duration: 250 },
                        plugins: {
                            legend: {
                                position: 'bottom',
                                labels: {
                                    font: { family: 'Plus Jakarta Sans', size: 10, weight: '600' },
                                    boxWidth: 10,
                                    padding: 8
                                }
                            },
                            tooltip: {
                                backgroundColor: '#0f172a',
                                padding: 8,
                                cornerRadius: 6,
                                callbacks: {
                                    label: function(context) {
                                        return ` ${context.label}: ${context.parsed} students`;
                                    }
                                }
                            }
                        }
                    }
                });
            } catch (err) {
                console.error('Error creating distribution chart:', err);
            }
        },

        renderStudentProgressChart() {
            if (typeof Chart === 'undefined') return;
            const canvas = document.getElementById('studentProgressCanvas');
            if (!canvas || !this.selectedStudentForProgress) return;

            if (this.currentTab !== 'progress' || this.progressViewMode !== 'student') return;

            if (canvas.clientWidth === 0 || canvas.clientHeight === 0) {
                if (!this._studentRenderRetries || this._studentRenderRetries < 5) {
                    this._studentRenderRetries = (this._studentRenderRetries || 0) + 1;
                    setTimeout(() => this.renderStudentProgressChart(), 50);
                    return;
                }
            }
            this._studentRenderRetries = 0;

            const student = this.selectedStudentForProgress;
            const allAssignments = (this.progressData && this.progressData.assignments) || [];
            
            const labels = [];
            const studentScores = [];
            const studentRawInfos = [];
            const classAverages = [];

            allAssignments.forEach(asg => {
                labels.push(asg.title);
                const mark = (student.history || []).find(h => String(h.assignment_id) === String(asg.id));
                studentScores.push(mark ? mark.score : null);
                studentRawInfos.push(mark ? { raw: mark.raw_score, max: mark.max_score || asg.max_marks || 100 } : null);
                classAverages.push(asg.average);
            });

            const chartLabels = labels.length ? labels : ['No Assessments Recorded'];

            // 1. If an existing chart is active, update cleanly without animation ('none') to avoid NaN interpolation
            let chart = appChartStore.student || Chart.getChart(canvas);
            if (chart && chart.ctx && chart.data && chart.data.datasets && chart.data.datasets.length >= 2) {
                try {
                    chart.data.labels = chartLabels;
                    chart.data.datasets[0].label = `${student.name}'s Score`;
                    chart.data.datasets[0].data = studentScores;
                    chart.data.datasets[0].rawInfos = studentRawInfos;
                    chart.data.datasets[1].data = classAverages;
                    chart.resize();
                    chart.update('none');
                    appChartStore.student = chart;
                    return;
                } catch (e) {
                    console.warn('Error updating existing student chart, recreating:', e);
                    try { chart.destroy(); } catch(err) {}
                    appChartStore.student = null;
                }
            }

            // 2. Otherwise safely clean any orphaned chart on the canvas
            const existing = Chart.getChart(canvas);
            if (existing) {
                try { existing.destroy(); } catch(e) {}
            }
            if (appChartStore.student) {
                try { appChartStore.student.destroy(); } catch(e) {}
                appChartStore.student = null;
            }

            const ctx = canvas.getContext('2d');
            if (!ctx) return;

            try {
                appChartStore.student = new Chart(ctx, {
                    type: 'line',
                    data: {
                        labels: chartLabels,
                        datasets: [
                            {
                                label: `${student.name}'s Score`,
                                data: studentScores,
                                rawInfos: studentRawInfos,
                                borderColor: '#4f46e5',
                                backgroundColor: 'rgba(79, 70, 229, 0.12)',
                                borderWidth: 3.5,
                                fill: true,
                                tension: 0.35,
                                pointRadius: 8,
                                pointHoverRadius: 10,
                                pointHitRadius: 15,
                                pointBackgroundColor: '#4f46e5',
                                pointBorderColor: '#ffffff',
                                pointBorderWidth: 3,
                                spanGaps: true
                            },
                            {
                                label: 'Class Benchmark Avg',
                                data: classAverages,
                                borderColor: '#94a3b8',
                                backgroundColor: 'transparent',
                                borderWidth: 2,
                                borderDash: [5, 5],
                                tension: 0.35,
                                pointRadius: 4,
                                pointBackgroundColor: '#94a3b8',
                                spanGaps: true
                            }
                        ]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        animation: { duration: 250 },
                        plugins: {
                            legend: {
                                position: 'top',
                                labels: {
                                    font: { family: 'Plus Jakarta Sans', weight: '700', size: 12 },
                                    boxWidth: 14,
                                    padding: 15
                                }
                            },
                            tooltip: {
                                backgroundColor: '#0f172a',
                                titleFont: { family: 'Plus Jakarta Sans', weight: '700', size: 12 },
                                bodyFont: { family: 'Plus Jakarta Sans', size: 11 },
                                padding: 12,
                                cornerRadius: 8,
                                callbacks: {
                                    label: function(context) {
                                        if (context.parsed.y === null || context.parsed.y === undefined) {
                                            return ` ${context.dataset.label}: Missed / Not Recorded`;
                                        }
                                        const rawInfo = context.dataset.rawInfos && context.dataset.rawInfos[context.dataIndex];
                                        if (rawInfo && rawInfo.max && Number(rawInfo.max) !== 100 && rawInfo.raw !== undefined) {
                                            return ` ${context.dataset.label}: ${context.parsed.y}% (Raw: ${rawInfo.raw} / ${rawInfo.max})`;
                                        }
                                        return ` ${context.dataset.label}: ${context.parsed.y}%`;
                                    },
                                    afterBody: function(items) {
                                        if (items && items.length >= 2 && items[0].parsed.y !== null && items[0].parsed.y !== undefined && items[1].parsed.y !== null && items[1].parsed.y !== undefined) {
                                            const diff = Math.round((items[0].parsed.y - items[1].parsed.y) * 10) / 10;
                                            if (diff > 0) return ` Performance: +${diff}% above class average`;
                                            if (diff < 0) return ` Performance: ${diff}% below class average`;
                                            return ` Performance: Matched class average`;
                                        }
                                        return '';
                                    }
                                }
                            }
                        },
                        scales: {
                            y: {
                                min: 0,
                                max: 100,
                                ticks: {
                                    stepSize: 20,
                                    callback: val => val + '%',
                                    font: { family: 'Plus Jakarta Sans', size: 11 }
                                },
                                grid: { color: '#f1f5f9' }
                            },
                            x: {
                                ticks: {
                                    font: { family: 'Plus Jakarta Sans', weight: '600', size: 11 }
                                },
                                grid: { display: false }
                            }
                        }
                    }
                });
            } catch (err) {
                console.error('Error creating student progress chart:', err);
            }
        }
    }))
})
