import sqlite3
import os
import sys

class DatabaseManager:
    def __init__(self, db_path=None):
        if db_path is None:
            # When packaged as a .exe, store data/app.db next to the executable so data persists
            if getattr(sys, 'frozen', False):
                base_dir = os.path.dirname(sys.executable)
            else:
                base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            db_path = os.path.join(base_dir, 'data', 'app.db')
        self.db_path = db_path
        self.init_db()

    def get_connection(self):
        return sqlite3.connect(self.db_path)

    def init_db(self):
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        schema_path = os.path.join(os.path.dirname(__file__), 'schema.sql')
        if os.path.exists(schema_path):
            with open(schema_path, 'r') as f:
                schema_script = f.read()
            
            with self.get_connection() as conn:
                conn.executescript(schema_script)
                # Ensure password column exists if updating from old schema
                try:
                    conn.execute("ALTER TABLE Faculties ADD COLUMN password_hash TEXT DEFAULT ''")
                except sqlite3.OperationalError:
                    pass # Column already exists
                    
                # Add Soft Delete columns
                try:
                    conn.execute("ALTER TABLE Students ADD COLUMN status TEXT DEFAULT 'active'")
                    conn.execute("ALTER TABLE Students ADD COLUMN remark TEXT DEFAULT ''")
                except sqlite3.OperationalError:
                    pass # Columns already exist

                # Add Attendance, Status, Insight and Faculty isolation columns
                try:
                    conn.execute("ALTER TABLE Students ADD COLUMN attendance TEXT DEFAULT '85%'")
                except sqlite3.OperationalError:
                    pass
                try:
                    conn.execute("ALTER TABLE Students ADD COLUMN submission_status TEXT DEFAULT 'On-time'")
                except sqlite3.OperationalError:
                    pass
                try:
                    conn.execute("ALTER TABLE Students ADD COLUMN custom_insight TEXT DEFAULT ''")
                except sqlite3.OperationalError:
                    pass
                try:
                    conn.execute("ALTER TABLE Students ADD COLUMN faculty_id INTEGER")
                except sqlite3.OperationalError:
                    pass

                # Add Faculty profile metadata columns
                faculty_columns = [
                    ("email", "TEXT DEFAULT ''"),
                    ("department", "TEXT DEFAULT 'Computer Science & Engineering'"),
                    ("designation", "TEXT DEFAULT 'Assistant Professor'"),
                    ("course_code", "TEXT DEFAULT 'CS301'"),
                    ("credits", "INTEGER DEFAULT 4"),
                    ("semester", "TEXT DEFAULT 'Semester V (2026)'"),
                    ("syllabus_units", "TEXT DEFAULT 'Unit 1: Foundations of Data Science\nUnit 2: Data Wrangling & Exploratory Analysis\nUnit 3: Machine Learning & Predictive Modeling\nUnit 4: Big Data Frameworks (Hadoop & Spark)\nUnit 5: Model Deployment & Data Ethics'"),
                    ("syllabus_file", "TEXT DEFAULT 'Data Science.pdf'"),
                    ("syllabus_path", "TEXT DEFAULT ''"),
                    ("profile_photo", "TEXT DEFAULT ''"),
                    ("api_key", "TEXT DEFAULT ''"),
                ]
                for col_name, col_def in faculty_columns:
                    try:
                        conn.execute(f"ALTER TABLE Faculties ADD COLUMN {col_name} {col_def}")
                    except sqlite3.OperationalError:
                        pass

                # Add max_marks to Assignments and raw_score / submission_status to Marks
                for tbl_col in [
                    "ALTER TABLE Assignments ADD COLUMN max_marks REAL DEFAULT 100",
                    "ALTER TABLE Marks ADD COLUMN raw_score REAL",
                    "ALTER TABLE Marks ADD COLUMN max_score REAL DEFAULT 100",
                    "ALTER TABLE Marks ADD COLUMN submission_status TEXT DEFAULT 'On-time'",
                ]:
                    try:
                        conn.execute(tbl_col)
                    except sqlite3.OperationalError:
                        pass

                # Ensure QuestionBank table exists
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS QuestionBank (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        faculty_id INTEGER,
                        title TEXT NOT NULL,
                        chapter TEXT DEFAULT '',
                        difficulty TEXT DEFAULT 'Moderate',
                        questions_json TEXT NOT NULL,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        FOREIGN KEY(faculty_id) REFERENCES Faculties(id)
                    )
                """)

                # Backfill legacy NULL faculty_id records to the primary faculty so existing data is preserved
                cursor = conn.cursor()
                cursor.execute("SELECT id FROM Faculties ORDER BY id ASC LIMIT 1")
                first_fac = cursor.fetchone()
                if first_fac:
                    default_fid = first_fac[0]
                    conn.execute("UPDATE Students SET faculty_id = ? WHERE faculty_id IS NULL", (default_fid,))
                    conn.execute("UPDATE Assignments SET faculty_id = ? WHERE faculty_id IS NULL", (default_fid,))
                    conn.execute("UPDATE QuestionBank SET faculty_id = ? WHERE faculty_id IS NULL", (default_fid,))

                # Migrate legacy Students table if roll_number is globally UNIQUE instead of per-faculty UNIQUE(faculty_id, roll_number)
                cursor.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='Students'")
                st_sql_row = cursor.fetchone()
                if st_sql_row and st_sql_row[0] and "roll_number TEXT UNIQUE" in st_sql_row[0]:
                    conn.execute("PRAGMA foreign_keys = OFF")
                    conn.execute("""
                        CREATE TABLE IF NOT EXISTS Students_new (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            name TEXT NOT NULL,
                            roll_number TEXT NOT NULL,
                            status TEXT DEFAULT 'active',
                            remark TEXT DEFAULT '',
                            attendance TEXT DEFAULT '85%',
                            submission_status TEXT DEFAULT 'On-time',
                            custom_insight TEXT DEFAULT '',
                            faculty_id INTEGER,
                            UNIQUE(faculty_id, roll_number)
                        )
                    """)
                    conn.execute("""
                        INSERT OR IGNORE INTO Students_new (id, name, roll_number, status, remark, attendance, submission_status, custom_insight, faculty_id)
                        SELECT id, name, roll_number,
                               COALESCE(status, 'active'),
                               COALESCE(remark, ''),
                               COALESCE(attendance, '85%'),
                               COALESCE(submission_status, 'On-time'),
                               COALESCE(custom_insight, ''),
                               faculty_id
                        FROM Students
                    """)
                    conn.execute("DROP TABLE Students")
                    conn.execute("ALTER TABLE Students_new RENAME TO Students")
                    conn.execute("PRAGMA foreign_keys = ON")

                # Normalize any legacy numeric syllabus_units (e.g. '5') and unfreeze accidental auto-generated custom_insight values
                cursor.execute("SELECT id, subject, syllabus_units, syllabus_file FROM Faculties")
                for f_row in cursor.fetchall():
                    f_id, f_subj, f_units, f_file = f_row[0], f_row[1] or "Data Science", str(f_row[2] or "").strip(), str(f_row[3] or "").strip()
                    if not f_units or f_units.isdigit():
                        new_units = self._default_syllabus_units(f_subj)
                        new_file = f_file if f_file else f"{f_subj.strip() or 'Course'}.pdf"
                        conn.execute("UPDATE Faculties SET syllabus_units = ?, syllabus_file = ? WHERE id = ?", (new_units, new_file, f_id))

                conn.execute("""
                    UPDATE Students
                    SET custom_insight = ''
                    WHERE custom_insight IN (
                        'No assessments recorded yet',
                        'High initial mastery',
                        'Average baseline score',
                        'Needs early guidance',
                        'Steady consistent performance'
                    )
                    OR custom_insight LIKE 'Strong surge (% pts)'
                    OR custom_insight LIKE 'Upward growth (% pts)'
                    OR custom_insight LIKE 'Slight dip (% pts)'
                    OR custom_insight LIKE 'At-risk (% pts decline)'
                """)

                conn.commit()

    @staticmethod
    def _default_syllabus_units(subject="Data Science"):
        subj = (subject or "Data Science").strip() or "Data Science"
        if subj.lower() == "data science":
            return (
                "Unit 1: Foundations of Data Science\n"
                "Unit 2: Data Wrangling & Exploratory Analysis\n"
                "Unit 3: Machine Learning & Predictive Modeling\n"
                "Unit 4: Big Data Frameworks (Hadoop & Spark)\n"
                "Unit 5: Model Deployment & Data Ethics"
            )
        return (
            f"Unit 1: Foundations & Core Concepts of {subj}\n"
            f"Unit 2: Analytical Methods & Architecture in {subj}\n"
            f"Unit 3: Advanced Modeling & Algorithms in {subj}\n"
            f"Unit 4: Systems Implementation & Frameworks for {subj}\n"
            f"Unit 5: Real-World Applications, Optimization & Ethics in {subj}"
        )

    @staticmethod
    def _normalize_attendance(att):
        if att is None:
            return "85%"
        raw = str(att).replace("%", "").strip()
        try:
            val = float(raw)
            val = max(0.0, min(100.0, val))
            if val.is_integer():
                return f"{int(val)}%"
            return f"{round(val, 1)}%"
        except ValueError:
            return "85%"

    @staticmethod
    def _clamp_score(score):
        val = float(score)
        return max(0.0, min(100.0, val))

    def get_faculty_details(self, faculty_id):
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT id, name, subject, email, department, designation, 
                       course_code, credits, semester, syllabus_units, syllabus_file,
                       profile_photo, COALESCE(syllabus_path, ''), COALESCE(api_key, '')
                FROM Faculties WHERE id = ?
            """, (faculty_id,))
            row = cursor.fetchone()
            if not row:
                return None
            subj = (row[2] or "Data Science").strip()
            raw_units = str(row[9] or "").strip()
            syllabus_units = raw_units if (raw_units and not raw_units.isdigit()) else self._default_syllabus_units(subj)
            syllabus_file = str(row[10] or "").strip() or f"{subj}.pdf"
            return {
                "id": row[0],
                "name": row[1] or "",
                "subject": row[2] or "",
                "email": row[3] or "",
                "department": row[4] or "Computer Science & Engineering",
                "designation": row[5] or "Assistant Professor",
                "course_code": row[6] or "CS301",
                "credits": row[7] if row[7] is not None else 4,
                "semester": row[8] or "Semester V (2026)",
                "syllabus_units": syllabus_units,
                "syllabus_file": syllabus_file,
                "profile_photo": row[11] or "",
                "syllabus_path": row[12] or "",
                "api_key": row[13] or ""
            }

    def update_faculty_photo(self, faculty_id, photo_data_url):
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("UPDATE Faculties SET profile_photo = ? WHERE id = ?", (photo_data_url or "", faculty_id))
            conn.commit()
            return True

    def update_faculty_password(self, faculty_id, new_password_hash):
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("UPDATE Faculties SET password_hash = ? WHERE id = ?", (new_password_hash, faculty_id))
            conn.commit()
            return True

    def update_faculty_api_key(self, faculty_id, api_key):
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("UPDATE Faculties SET api_key = ? WHERE id = ?", ((api_key or "").strip(), faculty_id))
            conn.commit()
            return True

    def get_any_configured_api_key(self, faculty_id=None):
        with self.get_connection() as conn:
            cursor = conn.cursor()
            if faculty_id is not None:
                cursor.execute("SELECT api_key FROM Faculties WHERE id = ? AND api_key IS NOT NULL AND TRIM(api_key) != ''", (faculty_id,))
                row = cursor.fetchone()
                if row and row[0]:
                    return row[0].strip()
            cursor.execute("SELECT api_key FROM Faculties WHERE api_key IS NOT NULL AND TRIM(api_key) != '' ORDER BY id ASC LIMIT 1")
            row = cursor.fetchone()
            return row[0].strip() if row and row[0] else ""

    def update_faculty_details(self, faculty_id, data):
        with self.get_connection() as conn:
            cursor = conn.cursor()
            faculty_name = (data.get("name") or "").strip()
            if faculty_name:
                cursor.execute("""
                    UPDATE Faculties 
                    SET name = ?, subject = ?, email = ?, department = ?, designation = ?,
                        course_code = ?, credits = ?, semester = ?, syllabus_units = ?, syllabus_file = ?
                    WHERE id = ?
                """, (
                    faculty_name,
                    data.get("subject", ""),
                    data.get("email", ""),
                    data.get("department", "Computer Science & Engineering"),
                    data.get("designation", "Assistant Professor"),
                    data.get("course_code", "CS301"),
                    int(data.get("credits", 4)),
                    data.get("semester", "Semester V (2026)"),
                    data.get("syllabus_units", ""),
                    data.get("syllabus_file", "Data Science.pdf"),
                    faculty_id
                ))
            else:
                cursor.execute("""
                    UPDATE Faculties 
                    SET subject = ?, email = ?, department = ?, designation = ?,
                        course_code = ?, credits = ?, semester = ?, syllabus_units = ?, syllabus_file = ?
                    WHERE id = ?
                """, (
                    data.get("subject", ""),
                    data.get("email", ""),
                    data.get("department", "Computer Science & Engineering"),
                    data.get("designation", "Assistant Professor"),
                    data.get("course_code", "CS301"),
                    int(data.get("credits", 4)),
                    data.get("semester", "Semester V (2026)"),
                    data.get("syllabus_units", ""),
                    data.get("syllabus_file", "Data Science.pdf"),
                    faculty_id
                ))
            if "profile_photo" in data:
                cursor.execute("UPDATE Faculties SET profile_photo = ? WHERE id = ?", (data.get("profile_photo") or "", faculty_id))
            if "syllabus_path" in data and data.get("syllabus_path"):
                cursor.execute("UPDATE Faculties SET syllabus_path = ? WHERE id = ?", (data.get("syllabus_path"), faculty_id))
            if "api_key" in data and data.get("api_key") is not None:
                cursor.execute("UPDATE Faculties SET api_key = ? WHERE id = ?", (str(data.get("api_key")).strip(), faculty_id))
            conn.commit()
            return True

    def get_all_faculties(self):
        with self.get_connection() as conn:
            cursor = conn.cursor()
            try:
                cursor.execute("SELECT id, name, subject, profile_photo FROM Faculties")
                return cursor.fetchall()
            except sqlite3.OperationalError:
                cursor.execute("SELECT id, name, subject FROM Faculties")
                return [(r[0], r[1], r[2], "") for r in cursor.fetchall()]
            
    def get_faculty_password(self, faculty_id):
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT password_hash FROM Faculties WHERE id = ?", (faculty_id,))
            row = cursor.fetchone()
            return row[0] if row else None
            
    def add_faculty(self, name, subject, password_hash):
        with self.get_connection() as conn:
            cursor = conn.cursor()
            clean_subject = (subject or "Course").strip() or "Course"
            words = [w for w in clean_subject.split() if w]
            code_prefix = "".join(w[0].upper() for w in words[:3]) or "CRS"
            default_code = f"{code_prefix}101"
            default_units = self._default_syllabus_units(clean_subject)
            default_file = f"{clean_subject}.pdf"
            cursor.execute("""
                INSERT INTO Faculties (
                    name, subject, password_hash, department, designation,
                    course_code, credits, semester, syllabus_units, syllabus_file
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                name,
                clean_subject,
                password_hash,
                "Department of Computer Science & Engineering",
                "Course Instructor & Faculty Lead",
                default_code,
                4,
                "Current Semester",
                default_units,
                default_file
            ))
            conn.commit()
            return cursor.lastrowid
            
    def get_students(self, faculty_id=None):
        with self.get_connection() as conn:
            cursor = conn.cursor()
            if faculty_id is not None:
                cursor.execute(
                    "SELECT id, name, roll_number FROM Students WHERE (status = 'active' OR status IS NULL) AND faculty_id = ?",
                    (faculty_id,)
                )
            else:
                cursor.execute("SELECT id, name, roll_number FROM Students WHERE status = 'active' OR status IS NULL")
            return cursor.fetchall()
            
    def get_past_students(self, faculty_id=None):
        with self.get_connection() as conn:
            cursor = conn.cursor()
            if faculty_id is not None:
                cursor.execute(
                    "SELECT id, name, roll_number, remark FROM Students WHERE status = 'deleted' AND faculty_id = ?",
                    (faculty_id,)
                )
            else:
                cursor.execute("SELECT id, name, roll_number, remark FROM Students WHERE status = 'deleted'")
            return cursor.fetchall()
            
    def add_student(self, name, roll_number, faculty_id=None, attendance=None):
        clean_name = name.strip()
        clean_roll = roll_number.strip()
        norm_att = self._normalize_attendance(attendance) if attendance and str(attendance).strip() else "85%"
        with self.get_connection() as conn:
            cursor = conn.cursor()
            # Check if a student with this roll_number already exists for this faculty
            if faculty_id is not None:
                cursor.execute(
                    "SELECT id, status FROM Students WHERE LOWER(TRIM(roll_number)) = LOWER(TRIM(?)) AND faculty_id = ?",
                    (clean_roll, faculty_id)
                )
            else:
                cursor.execute(
                    "SELECT id, status FROM Students WHERE LOWER(TRIM(roll_number)) = LOWER(TRIM(?))",
                    (clean_roll,)
                )
            existing = cursor.fetchone()
            if existing:
                if existing[1] == 'deleted':
                    # Auto-restore soft-deleted student with updated name
                    cursor.execute(
                        "UPDATE Students SET name = ?, roll_number = ?, attendance = ?, status = 'active', remark = '', faculty_id = COALESCE(faculty_id, ?) WHERE id = ?",
                        (clean_name, clean_roll, norm_att, faculty_id, existing[0])
                    )
                    conn.commit()
                    return True
                return False

            try:
                cursor.execute(
                    "INSERT INTO Students (name, roll_number, attendance, status, faculty_id) VALUES (?, ?, ?, 'active', ?)",
                    (clean_name, clean_roll, norm_att, faculty_id)
                )
                conn.commit()
                return True
            except sqlite3.IntegrityError:
                return False

    def update_student_info(self, student_id, name, roll_number):
        clean_name = name.strip()
        clean_roll = roll_number.strip()
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT faculty_id FROM Students WHERE id = ?", (student_id,))
            fac_row = cursor.fetchone()
            fac_id = fac_row[0] if fac_row else None
            if fac_id is not None:
                cursor.execute(
                    "SELECT id FROM Students WHERE LOWER(TRIM(roll_number)) = LOWER(TRIM(?)) AND faculty_id = ? AND id != ?",
                    (clean_roll, fac_id, student_id)
                )
                if cursor.fetchone():
                    return False, "Roll number already exists for another student in this course."
            try:
                cursor.execute(
                    "UPDATE Students SET name = ?, roll_number = ? WHERE id = ?",
                    (clean_name, clean_roll, student_id)
                )
                conn.commit()
                return True, "Student updated successfully"
            except sqlite3.IntegrityError:
                return False, "Roll number already exists for another student."

    def restore_student(self, student_id):
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("UPDATE Students SET status = 'active', remark = '' WHERE id = ?", (student_id,))
            conn.commit()
            return True
                
    def delete_student(self, student_id, remark):
        with self.get_connection() as conn:
            cursor = conn.cursor()
            # Soft delete instead of hard delete to preserve history and grades
            cursor.execute("UPDATE Students SET status = 'deleted', remark = ? WHERE id = ?", (remark, student_id))
            conn.commit()
            return True

    def get_all_marks(self, faculty_id=None):
        with self.get_connection() as conn:
            cursor = conn.cursor()
            try:
                if faculty_id is not None:
                    cursor.execute("""
                        SELECT m.student_id, m.assignment_id, m.score
                        FROM Marks m
                        JOIN Students s ON m.student_id = s.id
                        JOIN Assignments a ON m.assignment_id = a.id
                        WHERE (s.status = 'active' OR s.status IS NULL)
                          AND s.faculty_id = ? AND a.faculty_id = ?
                    """, (faculty_id, faculty_id))
                else:
                    cursor.execute("""
                        SELECT m.student_id, m.assignment_id, m.score
                        FROM Marks m
                        JOIN Students s ON m.student_id = s.id
                        WHERE s.status = 'active' OR s.status IS NULL
                    """)
                return cursor.fetchall()
            except sqlite3.OperationalError:
                return []

    def get_assignments(self, faculty_id=None):
        with self.get_connection() as conn:
            cursor = conn.cursor()
            if faculty_id is not None:
                cursor.execute(
                    "SELECT id, title, created_at, COALESCE(max_marks, 100) FROM Assignments WHERE faculty_id = ? ORDER BY created_at DESC, id DESC",
                    (faculty_id,)
                )
            else:
                cursor.execute("SELECT id, title, created_at, COALESCE(max_marks, 100) FROM Assignments ORDER BY created_at DESC, id DESC")
            return cursor.fetchall()

    def add_assignment(self, title, faculty_id=None, max_marks=100):
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("INSERT INTO Assignments (title, faculty_id, max_marks) VALUES (?, ?, ?)", (title, faculty_id, float(max_marks or 100)))
            conn.commit()
            return cursor.lastrowid

    def delete_assignment(self, assignment_id):
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM Marks WHERE assignment_id = ?", (assignment_id,))
            cursor.execute("DELETE FROM Assignments WHERE id = ?", (assignment_id,))
            conn.commit()
            return True

    def get_marks_for_assignment(self, assignment_id):
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT student_id, score, COALESCE(raw_score, score), COALESCE(max_score, 100), COALESCE(submission_status, 'On-time') FROM Marks WHERE assignment_id = ?",
                (assignment_id,)
            )
            return cursor.fetchall()

    def get_assignment_marks_dict(self, assignment_id):
        rows = self.get_marks_for_assignment(assignment_id)
        return {r[0]: round(float(r[2] if r[2] is not None else r[1]), 1) for r in rows}

    def get_assignment_full_details(self, assignment_id):
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT COALESCE(max_marks, 100) FROM Assignments WHERE id = ?", (assignment_id,))
            asg_row = cursor.fetchone()
            max_marks = float(asg_row[0]) if asg_row and asg_row[0] else 100.0
            rows = self.get_marks_for_assignment(assignment_id)
            marks_dict = {r[0]: round(float(r[2] if r[2] is not None else r[1]), 1) for r in rows}
            pct_dict = {r[0]: round(float(r[1]), 1) for r in rows}
            status_dict = {r[0]: (r[4] or "On-time") for r in rows}
            return {
                "max_marks": max_marks,
                "marks": marks_dict,
                "percentages": pct_dict,
                "statuses": status_dict
            }

    def save_marks(self, assignment_id, marks_list):
        """marks_list is a list of (student_id, score) tuples"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            for student_id, score in marks_list:
                sc = self._clamp_score(score)
                cursor.execute("SELECT id FROM Marks WHERE student_id = ? AND assignment_id = ?", (student_id, assignment_id))
                existing = cursor.fetchone()
                if existing:
                    cursor.execute("UPDATE Marks SET score = ?, raw_score = ? WHERE id = ?", (sc, sc, existing[0]))
                else:
                    cursor.execute("INSERT INTO Marks (student_id, assignment_id, score, raw_score) VALUES (?, ?, ?, ?)", (student_id, assignment_id, sc, sc))
            conn.commit()
            return True

    def get_student_marks_summary(self):
        """Returns each student with their latest two assignment scores"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT s.id, s.name, s.roll_number, a.title, m.score
                FROM Students s
                LEFT JOIN Marks m ON s.id = m.student_id
                LEFT JOIN Assignments a ON m.assignment_id = a.id
                WHERE s.status = 'active' OR s.status IS NULL
                ORDER BY s.id, a.created_at DESC
            """)
            return cursor.fetchall()

    def get_students_with_metrics(self, faculty_id=None):
        with self.get_connection() as conn:
            cursor = conn.cursor()
            try:
                if faculty_id is not None:
                    cursor.execute("""
                        SELECT id, name, roll_number, attendance, submission_status, custom_insight
                        FROM Students
                        WHERE (status = 'active' OR status IS NULL)
                          AND faculty_id = ?
                        ORDER BY id ASC
                    """, (faculty_id,))
                else:
                    cursor.execute("""
                        SELECT id, name, roll_number, attendance, submission_status, custom_insight
                        FROM Students
                        WHERE status = 'active' OR status IS NULL
                        ORDER BY id ASC
                    """)
                students = cursor.fetchall()
            except sqlite3.OperationalError:
                cursor.execute("SELECT id, name, roll_number FROM Students WHERE status = 'active' OR status IS NULL")
                raw = cursor.fetchall()
                students = [(r[0], r[1], r[2], "85%", "On-time", "") for r in raw]

            result = []
            for s in students:
                s_id, name, roll = s[0], s[1], s[2]
                attendance = self._normalize_attendance(s[3] if len(s) > 3 and s[3] else "85%")
                status = s[4] if len(s) > 4 and s[4] else "On-time"
                custom_insight = s[5] if len(s) > 5 and s[5] else ""

                # Fetch all marks for this student ordered chronologically
                if faculty_id is not None:
                    cursor.execute("""
                        SELECT m.score, a.title, COALESCE(m.raw_score, m.score), COALESCE(m.max_score, a.max_marks, 100), COALESCE(m.submission_status, 'On-time'), a.id
                        FROM Marks m
                        JOIN Assignments a ON m.assignment_id = a.id
                        WHERE m.student_id = ? AND a.faculty_id = ?
                        ORDER BY a.created_at ASC, a.id ASC
                    """, (s_id, faculty_id))
                else:
                    cursor.execute("""
                        SELECT m.score, a.title, COALESCE(m.raw_score, m.score), COALESCE(m.max_score, a.max_marks, 100), COALESCE(m.submission_status, 'On-time'), a.id
                        FROM Marks m
                        JOIN Assignments a ON m.assignment_id = a.id
                        WHERE m.student_id = ?
                        ORDER BY a.created_at ASC, a.id ASC
                    """, (s_id,))
                marks = cursor.fetchall()

                if not marks:
                    prev_val = "--"
                    latest_val = "--"
                    status = "--"
                    auto_insight = "No assessments recorded yet"
                elif len(marks) == 1:
                    prev_val = "--"
                    latest_val = f"{marks[0][0]:.0f}"
                    if marks[-1][4]:
                        status = marks[-1][4]
                    if marks[0][0] >= 75:
                        auto_insight = "High initial mastery"
                    elif marks[0][0] >= 50:
                        auto_insight = "Average baseline score"
                    else:
                        auto_insight = "Needs early guidance"
                else:
                    prev_score = marks[-2][0]
                    latest_score = marks[-1][0]
                    prev_val = f"{prev_score:.0f}"
                    latest_val = f"{latest_score:.0f}"
                    if marks[-1][4]:
                        status = marks[-1][4]
                    diff = latest_score - prev_score

                    if diff > 10:
                        auto_insight = f"Strong surge (+{diff:.0f} pts)"
                    elif diff > 0:
                        auto_insight = f"Upward growth (+{diff:.0f} pts)"
                    elif diff == 0:
                        auto_insight = "Steady consistent performance"
                    elif diff >= -10:
                        auto_insight = f"Slight dip ({diff:.0f} pts)"
                    else:
                        auto_insight = f"At-risk ({diff:.0f} pts decline)"

                insight = custom_insight if custom_insight else auto_insight

                all_marks_list = [
                    {
                        "score": round(float(m[0]), 1),
                        "title": m[1],
                        "raw_score": round(float(m[2]), 1),
                        "max_score": round(float(m[3]), 1),
                        "status": m[4] or "On-time",
                        "assignment_id": m[5]
                    }
                    for m in marks
                ]
                if marks:
                    numeric_scores = [float(m[0]) for m in marks]
                    overall_avg_val = round(sum(numeric_scores) / len(numeric_scores), 1)
                    best_score_val = round(max(numeric_scores), 1)
                    lowest_score_val = round(min(numeric_scores), 1)
                    latest_numeric = numeric_scores[-1]
                else:
                    overall_avg_val = "--"
                    best_score_val = "--"
                    lowest_score_val = "--"
                    latest_numeric = None

                result.append({
                    "id": s_id,
                    "name": name,
                    "roll": roll,
                    "attendance": attendance,
                    "prev": prev_val,
                    "latest": latest_val,
                    "latest_numeric": latest_numeric,
                    "overall_average": overall_avg_val,
                    "best_score": best_score_val,
                    "lowest_score": lowest_score_val,
                    "total_assessments": len(marks),
                    "all_marks": all_marks_list,
                    "status": status,
                    "insight": insight,
                    "custom_insight": custom_insight,
                    "auto_insight": auto_insight
                })

            return result

    def update_student_record(self, student_id, attendance, status, score=None, assignment_title="Assessment", custom_insight="", faculty_id=None, max_marks=100):
        with self.get_connection() as conn:
            cursor = conn.cursor()
            norm_att = self._normalize_attendance(attendance)
            clean_title = (assignment_title or "Assessment").strip()
            # Update student info
            cursor.execute("""
                UPDATE Students
                SET attendance = ?, submission_status = ?, custom_insight = ?
                WHERE id = ?
            """, (norm_att, status, custom_insight, student_id))

            # Check if assignment already exists
            if faculty_id is not None:
                cursor.execute(
                    "SELECT id, COALESCE(max_marks, 100) FROM Assignments WHERE LOWER(TRIM(title)) = LOWER(TRIM(?)) AND faculty_id = ?",
                    (clean_title, faculty_id)
                )
            else:
                cursor.execute(
                    "SELECT id, COALESCE(max_marks, 100) FROM Assignments WHERE LOWER(TRIM(title)) = LOWER(TRIM(?))",
                    (clean_title,)
                )
            row = cursor.fetchone()

            # If score provided, record it in an assignment
            if score is not None and str(score).strip() != "":
                try:
                    raw_input = float(score)
                    if row:
                        assignment_id = row[0]
                        asg_max = float(max_marks) if max_marks and float(max_marks) > 0 else float(row[1] or 100)
                        cursor.execute("UPDATE Assignments SET max_marks = ? WHERE id = ?", (asg_max, assignment_id))
                    else:
                        asg_max = float(max_marks) if max_marks and float(max_marks) > 0 else 100.0
                        cursor.execute(
                            "INSERT INTO Assignments (title, faculty_id, max_marks) VALUES (?, ?, ?)",
                            (clean_title, faculty_id, asg_max)
                        )
                        assignment_id = cursor.lastrowid

                    raw_clamped = max(0.0, min(asg_max, raw_input))
                    pct_score = self._clamp_score((raw_clamped / asg_max) * 100.0) if asg_max > 0 else self._clamp_score(raw_input)

                    # Save or update mark
                    cursor.execute("SELECT id FROM Marks WHERE student_id = ? AND assignment_id = ?", (student_id, assignment_id))
                    existing = cursor.fetchone()
                    if existing:
                        cursor.execute(
                            "UPDATE Marks SET score = ?, raw_score = ?, max_score = ?, submission_status = ? WHERE id = ?",
                            (pct_score, raw_clamped, asg_max, status, existing[0])
                        )
                    else:
                        cursor.execute(
                            "INSERT INTO Marks (student_id, assignment_id, score, raw_score, max_score, submission_status) VALUES (?, ?, ?, ?, ?, ?)",
                            (student_id, assignment_id, pct_score, raw_clamped, asg_max, status)
                        )
                except ValueError:
                    pass
            elif row:
                # Score was explicitly cleared for an existing assessment: remove the mark entry
                assignment_id = row[0]
                try:
                    if max_marks and float(max_marks) > 0:
                        cursor.execute("UPDATE Assignments SET max_marks = ? WHERE id = ?", (float(max_marks), assignment_id))
                except (ValueError, TypeError):
                    pass
                cursor.execute("DELETE FROM Marks WHERE student_id = ? AND assignment_id = ?", (student_id, assignment_id))

            conn.commit()
            return True

    def batch_record_marks(self, assignment_title, records, faculty_id=None, assignment_id=None, max_marks=100):
        """
        records is a list of dicts:
        [{ "student_id": 1, "score": 85, "attendance": "90%", "status": "On-time" }]
        """
        with self.get_connection() as conn:
            cursor = conn.cursor()
            clean_title = assignment_title.strip()
            try:
                asg_max = float(max_marks) if max_marks and float(max_marks) > 0 else 100.0
            except (ValueError, TypeError):
                asg_max = 100.0

            if assignment_id is not None:
                cursor.execute("UPDATE Assignments SET title = ?, max_marks = ? WHERE id = ?", (clean_title, asg_max, assignment_id))
                target_asg_id = assignment_id
            else:
                if faculty_id is not None:
                    cursor.execute(
                        "SELECT id FROM Assignments WHERE LOWER(TRIM(title)) = LOWER(TRIM(?)) AND faculty_id = ?",
                        (clean_title, faculty_id)
                    )
                else:
                    cursor.execute(
                        "SELECT id FROM Assignments WHERE LOWER(TRIM(title)) = LOWER(TRIM(?))",
                        (clean_title,)
                    )
                row = cursor.fetchone()
                if row:
                    target_asg_id = row[0]
                    cursor.execute("UPDATE Assignments SET max_marks = ? WHERE id = ?", (asg_max, target_asg_id))
                else:
                    cursor.execute("INSERT INTO Assignments (title, faculty_id, max_marks) VALUES (?, ?, ?)", (clean_title, faculty_id, asg_max))
                    target_asg_id = cursor.lastrowid

            for item in records:
                s_id = item.get("student_id")
                score_val = item.get("score")
                stat = item.get("status", "On-time")
                insight = str(item.get("insight") or "").strip()
                has_score = score_val is not None and str(score_val).strip() != ""

                if insight:
                    cursor.execute("UPDATE Students SET custom_insight = ? WHERE id = ?", (insight, s_id))

                if has_score or stat == "Missing":
                    cursor.execute("UPDATE Students SET submission_status = ? WHERE id = ?", (stat, s_id))

                if has_score:
                    try:
                        raw_input = float(score_val)
                        raw_clamped = max(0.0, min(asg_max, raw_input))
                        sc = self._clamp_score((raw_clamped / asg_max) * 100.0) if asg_max > 0 else self._clamp_score(raw_input)
                        cursor.execute("SELECT id FROM Marks WHERE student_id = ? AND assignment_id = ?", (s_id, target_asg_id))
                        existing = cursor.fetchone()
                        if existing:
                            cursor.execute(
                                "UPDATE Marks SET score = ?, raw_score = ?, max_score = ?, submission_status = ? WHERE id = ?",
                                (sc, raw_clamped, asg_max, stat, existing[0])
                            )
                        else:
                            cursor.execute(
                                "INSERT INTO Marks (student_id, assignment_id, score, raw_score, max_score, submission_status) VALUES (?, ?, ?, ?, ?, ?)",
                                (s_id, target_asg_id, sc, raw_clamped, asg_max, stat)
                            )
                    except ValueError:
                        pass
                elif assignment_id is not None:
                    # In Edit Assessment mode, clearing a student's score removes their mark for this assignment
                    cursor.execute(
                        "DELETE FROM Marks WHERE student_id = ? AND assignment_id = ?",
                        (s_id, target_asg_id)
                    )

            conn.commit()
            return True

    def update_student_attendance(self, student_id, attendance):
        with self.get_connection() as conn:
            cursor = conn.cursor()
            norm_att = self._normalize_attendance(attendance)
            cursor.execute("UPDATE Students SET attendance = ? WHERE id = ?", (norm_att, student_id))
            conn.commit()
            return True

    def batch_update_attendance(self, records):
        """
        records is list of { "student_id": 1, "attendance": "90%" }
        """
        with self.get_connection() as conn:
            cursor = conn.cursor()
            for r in records:
                s_id = r.get("student_id")
                att = self._normalize_attendance(r.get("attendance", "85%"))
                cursor.execute("UPDATE Students SET attendance = ? WHERE id = ?", (att, s_id))
            conn.commit()
            return True

    def save_question_paper(self, faculty_id, title, chapter, difficulty, questions_list):
        import json
        with self.get_connection() as conn:
            cursor = conn.cursor()
            q_json = json.dumps(questions_list or [])
            cursor.execute(
                "INSERT INTO QuestionBank (faculty_id, title, chapter, difficulty, questions_json) VALUES (?, ?, ?, ?, ?)",
                (faculty_id, (title or "MCQ Assessment").strip(), (chapter or "").strip(), (difficulty or "Moderate").strip(), q_json)
            )
            conn.commit()
            return cursor.lastrowid

    def get_question_papers(self, faculty_id=None):
        import json
        with self.get_connection() as conn:
            cursor = conn.cursor()
            if faculty_id is not None:
                cursor.execute(
                    "SELECT id, title, chapter, difficulty, questions_json, created_at FROM QuestionBank WHERE faculty_id = ? ORDER BY created_at DESC, id DESC",
                    (faculty_id,)
                )
            else:
                cursor.execute(
                    "SELECT id, title, chapter, difficulty, questions_json, created_at FROM QuestionBank ORDER BY created_at DESC, id DESC"
                )
            rows = cursor.fetchall()
            papers = []
            for r in rows:
                try:
                    qs = json.loads(r[4]) if r[4] else []
                except Exception:
                    qs = []
                papers.append({
                    "id": r[0],
                    "title": r[1],
                    "chapter": r[2],
                    "difficulty": r[3],
                    "questions": qs,
                    "question_count": len(qs),
                    "created_at": str(r[5]) if r[5] else ""
                })
            return papers

    def delete_question_paper(self, paper_id):
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM QuestionBank WHERE id = ?", (paper_id,))
            conn.commit()
            return True

    def get_student_progress_analytics(self, faculty_id=None):
        """
        Returns full longitudinal progress analytics for:
        1. All assignments (timeline, class averages, high/low benchmarks)
        2. Overall cohort trends & distribution
        3. Every student's complete historical assessment scores, momentum, and insights
        """
        with self.get_connection() as conn:
            cursor = conn.cursor()

            # 1. Fetch active students
            if faculty_id is not None:
                cursor.execute("""
                    SELECT id, name, roll_number, attendance, submission_status, custom_insight
                    FROM Students
                    WHERE (status = 'active' OR status IS NULL)
                      AND faculty_id = ?
                    ORDER BY roll_number ASC, id ASC
                """, (faculty_id,))
            else:
                cursor.execute("""
                    SELECT id, name, roll_number, attendance, submission_status, custom_insight
                    FROM Students
                    WHERE status = 'active' OR status IS NULL
                    ORDER BY roll_number ASC, id ASC
                """)
            students_raw = cursor.fetchall()
            active_students = [
                {
                    "id": r[0],
                    "name": r[1],
                    "roll": r[2],
                    "attendance": self._normalize_attendance(r[3] if r[3] else "85%"),
                    "submission_status": r[4] if r[4] else "On-time",
                    "custom_insight": r[5] or ""
                }
                for r in students_raw
            ]
            active_sids = set(s["id"] for s in active_students)

            # 2. Fetch assignments
            if faculty_id is not None:
                cursor.execute("""
                    SELECT id, title, created_at, COALESCE(max_marks, 100)
                    FROM Assignments 
                    WHERE faculty_id = ?
                    ORDER BY created_at ASC, id ASC
                """, (faculty_id,))
            else:
                cursor.execute("""
                    SELECT id, title, created_at, COALESCE(max_marks, 100)
                    FROM Assignments 
                    ORDER BY created_at ASC, id ASC
                """)
            assignments_raw = cursor.fetchall()
            assignments_list = []
            for a in assignments_raw:
                assignments_list.append({
                    "id": a[0],
                    "title": a[1],
                    "created_at": str(a[2]) if a[2] else "",
                    "max_marks": float(a[3]) if a[3] else 100.0
                })

            # 3. Fetch all marks scoped to this faculty's assignments
            if faculty_id is not None:
                cursor.execute("""
                    SELECT m.student_id, m.assignment_id, m.score, a.title, a.created_at,
                           COALESCE(m.raw_score, m.score), COALESCE(m.max_score, a.max_marks, 100), COALESCE(m.submission_status, 'On-time')
                    FROM Marks m
                    JOIN Assignments a ON m.assignment_id = a.id
                    WHERE a.faculty_id = ?
                    ORDER BY a.created_at ASC, a.id ASC
                """, (faculty_id,))
            else:
                cursor.execute("""
                    SELECT m.student_id, m.assignment_id, m.score, a.title, a.created_at,
                           COALESCE(m.raw_score, m.score), COALESCE(m.max_score, a.max_marks, 100), COALESCE(m.submission_status, 'On-time')
                    FROM Marks m
                    JOIN Assignments a ON m.assignment_id = a.id
                    ORDER BY a.created_at ASC, a.id ASC
                """)
            marks_raw = cursor.fetchall()
            active_marks = [m for m in marks_raw if m[0] in active_sids]

            # 4. Assignment-level analytics
            asg_map = {}
            for a in assignments_list:
                a_id = a["id"]
                scores_for_asg = [float(m[2]) for m in active_marks if m[1] == a_id]
                count = len(scores_for_asg)
                avg = round(sum(scores_for_asg) / count, 1) if count > 0 else 0
                max_s = round(max(scores_for_asg), 1) if count > 0 else 0
                min_s = round(min(scores_for_asg), 1) if count > 0 else 0
                pass_count = sum(1 for s in scores_for_asg if s >= 50)
                pass_rate = round(pass_count / count * 100, 1) if count > 0 else 0

                asg_data = {
                    "id": a_id,
                    "title": a["title"],
                    "created_at": a["created_at"],
                    "max_marks": a["max_marks"],
                    "submission_count": count,
                    "average": avg,
                    "highest": max_s,
                    "lowest": min_s,
                    "pass_rate": pass_rate
                }
                asg_map[a_id] = asg_data

            # 5. Student-level analytics
            students_result = []
            all_student_averages = []

            for s in active_students:
                s_id = s["id"]
                s_marks = [m for m in active_marks if m[0] == s_id]
                
                # Chronological history for this student
                history = []
                prev_score = None
                scores_list = []

                for m in s_marks:
                    asg_id = m[1]
                    score = round(float(m[2]), 1)
                    raw_score = round(float(m[5]), 1)
                    max_score = round(float(m[6]), 1)
                    sub_status = m[7] or "On-time"
                    scores_list.append(score)
                    asg_info = asg_map.get(asg_id, {})
                    class_avg = asg_info.get("average", 0)
                    
                    delta_prev = round(score - prev_score, 1) if prev_score is not None else 0
                    delta_avg = round(score - class_avg, 1)

                    history.append({
                        "assignment_id": asg_id,
                        "title": m[3],
                        "score": score,
                        "raw_score": raw_score,
                        "max_score": max_score,
                        "status": sub_status,
                        "submission_status": sub_status,
                        "date": str(m[4]) if m[4] else "",
                        "class_average": class_avg,
                        "delta_from_class_avg": delta_avg,
                        "delta_from_prev": delta_prev
                    })
                    prev_score = score

                total_taken = len(scores_list)
                if total_taken > 0:
                    overall_avg = round(sum(scores_list) / total_taken, 1)
                    best_score = round(max(scores_list), 1)
                    lowest_score = round(min(scores_list), 1)
                    first_score = round(scores_list[0], 1)
                    latest_score = round(scores_list[-1], 1)
                    growth_pts = round(latest_score - first_score, 1) if total_taken >= 2 else 0
                    all_student_averages.append(overall_avg)
                else:
                    overall_avg = 0
                    best_score = 0
                    lowest_score = 0
                    first_score = 0
                    latest_score = 0
                    growth_pts = 0

                # Trend classification
                if total_taken == 0:
                    trend_status = "No Assessments"
                    trend_color = "gray"
                elif total_taken == 1:
                    trend_status = "Baseline Set"
                    trend_color = "blue"
                elif growth_pts >= 10:
                    trend_status = "Strong Growth"
                    trend_color = "emerald"
                elif growth_pts > 0:
                    trend_status = "Improving"
                    trend_color = "green"
                elif growth_pts == 0:
                    trend_status = "Consistent"
                    trend_color = "indigo"
                elif growth_pts >= -10:
                    trend_status = "Slight Dip"
                    trend_color = "amber"
                else:
                    trend_status = "Needs Guidance"
                    trend_color = "rose"

                # Grade classification
                if total_taken == 0: grade = "Not Assessed"
                elif overall_avg >= 90: grade = "A+"
                elif overall_avg >= 75: grade = "A"
                elif overall_avg >= 65: grade = "B+"
                elif overall_avg >= 55: grade = "B"
                elif overall_avg >= 50: grade = "C"
                else: grade = "Needs Support"

                # Smart Insight
                if s["custom_insight"]:
                    insight = s["custom_insight"]
                elif total_taken == 0:
                    insight = "No assessments recorded yet."
                elif trend_status == "Strong Growth":
                    insight = f"Impressive momentum (+{growth_pts:.0f} pts from baseline)."
                elif trend_status == "Improving":
                    insight = f"Steady positive upward progress (+{growth_pts:.0f} pts)."
                elif trend_status == "Consistent":
                    insight = "Consistently reliable performance across all tests."
                elif trend_status == "Slight Dip":
                    insight = f"Recent minor dip ({growth_pts:.0f} pts). Monitor next assignment."
                elif trend_status == "Needs Guidance":
                    insight = f"Noticeable decline ({growth_pts:.0f} pts). Requires targeted guidance."
                else:
                    insight = f"Baseline established at {latest_score:.0f}%."

                # Map of assignment_id -> score for table matrix
                score_by_asg = {m["assignment_id"]: m["score"] for m in history}

                students_result.append({
                    "id": s_id,
                    "name": s["name"],
                    "roll": s["roll"],
                    "attendance": s["attendance"],
                    "submission_status": history[-1]["status"] if history else s["submission_status"],
                    "total_assessments": total_taken,
                    "overall_average": overall_avg,
                    "best_score": best_score,
                    "lowest_score": lowest_score,
                    "first_score": first_score,
                    "latest_score": latest_score,
                    "growth_pts": growth_pts,
                    "trend_status": trend_status,
                    "trend_color": trend_color,
                    "grade": grade,
                    "insight": insight,
                    "history": history,
                    "scores_by_assignment": score_by_asg
                })

            # 6. Cohort overview metrics
            total_students_count = len(active_students)
            cohort_avg = round(sum(all_student_averages) / len(all_student_averages), 1) if all_student_averages else 0
            
            # Standardized distribution counts (Mastery >= 75%, Good 60-74.9%, Average 50-59.9%, At-Risk < 50%)
            dist_excellent = sum(1 for s in students_result if s["total_assessments"] > 0 and s["overall_average"] >= 75)
            dist_good = sum(1 for s in students_result if s["total_assessments"] > 0 and 60 <= s["overall_average"] < 75)
            dist_average = sum(1 for s in students_result if s["total_assessments"] > 0 and 50 <= s["overall_average"] < 60)
            dist_at_risk = sum(1 for s in students_result if s["total_assessments"] > 0 and s["overall_average"] < 50)
            dist_no_data = sum(1 for s in students_result if s["total_assessments"] == 0)

            # Class timeline for chart
            timeline = [asg_map[a["id"]] for a in assignments_list if a["id"] in asg_map]

            return {
                "cohort": {
                    "total_students": total_students_count,
                    "total_assignments": len(assignments_list),
                    "total_marks_recorded": len(active_marks),
                    "class_overall_average": cohort_avg,
                    "timeline": timeline,
                    "distribution": {
                        "excellent": dist_excellent,
                        "good": dist_good,
                        "average": dist_average,
                        "at_risk": dist_at_risk,
                        "no_data": dist_no_data
                    }
                },
                "assignments": [asg_map[a["id"]] for a in assignments_list if a["id"] in asg_map],
                "students": students_result
            }

