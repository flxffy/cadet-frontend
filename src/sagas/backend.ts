/*eslint no-eval: "error"*/
/*eslint-env browser*/
import { SagaIterator } from 'redux-saga';
import { call, put, select, takeEvery } from 'redux-saga/effects';

import * as actions from '../actions';
import * as actionTypes from '../actions/actionTypes';
import { WorkspaceLocation } from '../actions/workspaces';
import {
  Grading,
  GradingOverview,
  GradingQuestion
} from '../components/academy/grading/gradingShape';
import {
  AssessmentCategory,
  AssessmentStatuses,
  ExternalLibraryName,
  IAssessment,
  IAssessmentOverview,
  IProgrammingQuestion,
  IQuestion,
  QuestionType,
  QuestionTypes
} from '../components/assessment/assessmentShape';
import {
  Notification,
  NotificationFilterFunction
} from '../components/notification/notificationShape';
import { IPlaybackData } from '../components/sourcecast/sourcecastShape';
import { store } from '../createStore';
import { IState, Role } from '../reducers/states';
import { castLibrary } from '../utils/castBackend';
import { BACKEND_URL } from '../utils/constants';
import { history } from '../utils/history';
import { showSuccessMessage, showWarningMessage } from '../utils/notification';

/**
 * @property accessToken - backend access token
 * @property errorMessage - message to showWarningMessage on failure
 * @property body - request body, for HTTP POST
 * @property noHeaderAccept - if Accept: application/json should be omitted
 * @property refreshToken - backend refresh token
 * @property shouldRefresh - if should attempt to refresh access token
 *
 * If shouldRefresh, accessToken and refreshToken are required.
 */
type RequestOptions = {
  accessToken?: string;
  errorMessage?: string;
  body?: object;
  noHeaderAccept?: boolean;
  noContentType?: boolean;
  refreshToken?: string;
  shouldAutoLogout?: boolean;
  shouldRefresh?: boolean;
};

type Tokens = {
  accessToken: string;
  refreshToken: string;
};

function* backendSaga(): SagaIterator {
  yield takeEvery(actionTypes.FETCH_AUTH, function*(action) {
    const luminusCode = (action as actionTypes.IAction).payload;
    const tokens = yield call(postAuth, luminusCode);
    if (!tokens) {
      return yield history.push('/');
    }

    const user = yield call(getUser, tokens);
    if (!user) {
      return yield history.push('/');
    }

    // Old: Use dispatch instead of saga's put to guarantee the reducer has
    // finished setting values in the state before /academy begins rendering
    // New: Changed to yield put
    yield put(actions.setTokens(tokens));
    yield put(actions.setUser(user));
    yield history.push('/academy');
  });

  yield takeEvery(actionTypes.FETCH_ASSESSMENT_OVERVIEWS, function*() {
    const tokens = yield select((state: IState) => ({
      accessToken: state.session.accessToken,
      refreshToken: state.session.refreshToken
    }));
    const assessmentOverviews = yield call(getAssessmentOverviews, tokens);
    if (assessmentOverviews) {
      yield put(actions.updateAssessmentOverviews(assessmentOverviews));
    }
  });

  yield takeEvery(actionTypes.FETCH_ASSESSMENT, function*(action) {
    const tokens = yield select((state: IState) => ({
      accessToken: state.session.accessToken,
      refreshToken: state.session.refreshToken
    }));
    const id = (action as actionTypes.IAction).payload;
    const assessment: IAssessment = yield call(getAssessment, id, tokens);
    if (assessment) {
      yield put(actions.updateAssessment(assessment));
    }
  });

  yield takeEvery(actionTypes.SUBMIT_ANSWER, function*(action) {
    const role = yield select((state: IState) => state.session.role!);
    if (role !== Role.Student) {
      return yield call(showWarningMessage, 'Only students can submit answers.');
    }

    const tokens = yield select((state: IState) => ({
      accessToken: state.session.accessToken,
      refreshToken: state.session.refreshToken
    }));
    const questionId = (action as actionTypes.IAction).payload.id;
    const answer = (action as actionTypes.IAction).payload.answer;
    const resp = yield call(postAnswer, questionId, answer, tokens);
    if (!resp) {
      return yield call(showWarningMessage, "Couldn't reach our servers. Are you online?");
    }
    if (!resp.ok) {
      let errorMessage: string;
      switch (resp.status) {
        case 401:
          errorMessage = 'Session expired. Please login again.';
          break;
        case 400:
          errorMessage = "Can't save an empty answer.";
          break;
        default:
          errorMessage = `Something went wrong (got ${resp.status} response)`;
          break;
      }
      return yield call(showWarningMessage, errorMessage);
    }
    yield call(showSuccessMessage, 'Saved!', 1000);
    // Now, update the answer for the question in the assessment in the store
    const assessmentId = yield select(
      (state: IState) => state.workspaces.assessment.currentAssessment!
    );
    const assessment = yield select((state: IState) => state.session.assessments.get(assessmentId));
    const newQuestions = assessment.questions.slice().map((question: IQuestion) => {
      if (question.id === questionId) {
        return { ...question, answer };
      }
      return question;
    });
    const newAssessment = {
      ...assessment,
      questions: newQuestions
    };
    yield put(actions.updateAssessment(newAssessment));
    return yield put(actions.updateHasUnsavedChanges('assessment' as WorkspaceLocation, false));
  });

  yield takeEvery(actionTypes.SUBMIT_ASSESSMENT, function*(action) {
    const role = yield select((state: IState) => state.session.role!);
    if (role !== Role.Student) {
      return yield call(showWarningMessage, 'Only students can submit assessments.');
    }

    const tokens = yield select((state: IState) => ({
      accessToken: state.session.accessToken,
      refreshToken: state.session.refreshToken
    }));
    const assessmentId = (action as actionTypes.IAction).payload;
    const resp = yield call(postAssessment, assessmentId, tokens);
    if (!resp || !resp.ok) {
      return yield call(showWarningMessage, 'Something went wrong. Please try again.');
    }
    yield call(showSuccessMessage, 'Submitted!', 2000);
    // Now, update the status of the assessment overview in the store
    const overviews: IAssessmentOverview[] = yield select(
      (state: IState) => state.session.assessmentOverviews
    );
    const newOverviews = overviews.map(overview => {
      if (overview.id === assessmentId) {
        return { ...overview, status: AssessmentStatuses.submitted };
      }
      return overview;
    });
    return yield put(actions.updateAssessmentOverviews(newOverviews));
  });

  yield takeEvery(actionTypes.FETCH_GRADING_OVERVIEWS, function*(action) {
    const tokens = yield select((state: IState) => ({
      accessToken: state.session.accessToken,
      refreshToken: state.session.refreshToken
    }));

    const filterToGroup = (action as actionTypes.IAction).payload;

    const gradingOverviews = yield call(getGradingOverviews, tokens, filterToGroup);
    if (gradingOverviews) {
      yield put(actions.updateGradingOverviews(gradingOverviews));
    }
  });

  yield takeEvery(actionTypes.FETCH_GRADING, function*(action) {
    const tokens = yield select((state: IState) => ({
      accessToken: state.session.accessToken,
      refreshToken: state.session.refreshToken
    }));
    const id = (action as actionTypes.IAction).payload;
    const grading = yield call(getGrading, id, tokens);
    if (grading) {
      yield put(actions.updateGrading(id, grading));
    }
  });

  /**
   * Unsubmits the submission and updates the grading overviews of the new status.
   */
  yield takeEvery(actionTypes.UNSUBMIT_SUBMISSION, function*(action) {
    const tokens = yield select((state: IState) => ({
      accessToken: state.session.accessToken,
      refreshToken: state.session.refreshToken
    }));
    const { submissionId } = (action as actionTypes.IAction).payload;

    const resp: Response = yield postUnsubmit(submissionId, tokens);
    if (!resp || !resp.ok) {
      yield handleResponseError(resp);
      return;
    }

    const overviews = yield select((state: IState) => state.session.gradingOverviews || []);
    const newOverviews = (overviews as GradingOverview[]).map(overview => {
      if (overview.submissionId === submissionId) {
        return { ...overview, submissionStatus: 'attempted' };
      }
      return overview;
    });
    yield call(showSuccessMessage, 'Unsubmit successful', 1000);
    yield put(actions.updateGradingOverviews(newOverviews));
  });

  yield takeEvery(actionTypes.SUBMIT_GRADING, function*(action) {
    const role = yield select((state: IState) => state.session.role!);
    if (role === Role.Student) {
      return yield call(showWarningMessage, 'Only staff can submit answers.');
    }
    const {
      submissionId,
      questionId,
      gradeAdjustment,
      xpAdjustment
    } = (action as actionTypes.IAction).payload;
    const tokens = yield select((state: IState) => ({
      accessToken: state.session.accessToken,
      refreshToken: state.session.refreshToken
    }));
    const resp = yield postGrading(submissionId, questionId, gradeAdjustment, xpAdjustment, tokens);
    if (resp && resp.ok) {
      yield call(showSuccessMessage, 'Saved!', 1000);
      // Now, update the grade for the question in the Grading in the store
      const grading: Grading = yield select((state: IState) =>
        state.session.gradings.get(submissionId)
      );
      const newGrading = grading.slice().map((gradingQuestion: GradingQuestion) => {
        if (gradingQuestion.question.id === questionId) {
          gradingQuestion.grade = {
            gradeAdjustment,
            xpAdjustment,
            roomId: gradingQuestion.grade.roomId,
            grade: gradingQuestion.grade.grade,
            xp: gradingQuestion.grade.xp
          };
        }
        return gradingQuestion;
      });
      yield put(actions.updateGrading(submissionId, newGrading));
    } else {
      handleResponseError(resp);
    }
  });

  yield takeEvery(actionTypes.FETCH_NOTIFICATIONS, function*(action) {
    const tokens = yield select((state: IState) => ({
      accessToken: state.session.accessToken,
      refreshToken: state.session.refreshToken
    }));

    const notifications = yield call(getNotifications, tokens);

    yield put(actions.updateNotifications(notifications));
  });

  yield takeEvery(actionTypes.ACKNOWLEDGE_NOTIFICATIONS, function*(action) {
    const tokens = yield select((state: IState) => ({
      accessToken: state.session.accessToken,
      refreshToken: state.session.refreshToken
    }));

    const notificationFilter:
      | NotificationFilterFunction
      | undefined = (action as actionTypes.IAction).payload.withFilter;

    const notifications: Notification[] = yield select(
      (state: IState) => state.session.notifications
    );

    let notificationsToAcknowledge = notifications;

    if (notificationFilter) {
      notificationsToAcknowledge = notificationFilter(notifications);
    }

    if (notificationsToAcknowledge.length === 0) {
      return;
    }

    const ids = notificationsToAcknowledge.map(n => n.id);

    const newNotifications: Notification[] = notifications.filter(
      notification => !ids.includes(notification.id)
    );

    yield put(actions.updateNotifications(newNotifications));

    const resp: Response | null = yield call(postAcknowledgeNotifications, tokens, ids);

    if (!resp || !resp.ok) {
      yield call(showWarningMessage, "Something went wrong, couldn't acknowledge");
      return;
    }
  });

  yield takeEvery(actionTypes.NOTIFY_CHATKIT_USERS, function*(action) {
    const tokens = yield select((state: IState) => ({
      accessToken: state.session.accessToken,
      refreshToken: state.session.refreshToken
    }));

    const assessmentId = (action as actionTypes.IAction).payload.assessmentId;
    const submissionId = (action as actionTypes.IAction).payload.submissionId;
    yield call(postNotify, tokens, assessmentId, submissionId);
  });

  yield takeEvery(actionTypes.FETCH_SOURCECAST_INDEX, function*(action) {
    const tokens = yield select((state: IState) => ({
      accessToken: state.session.accessToken,
      refreshToken: state.session.refreshToken
    }));
    const sourcecastIndex = yield call(getSourcecastIndex, tokens);
    if (sourcecastIndex) {
      yield put(
        actions.updateSourcecastIndex(
          sourcecastIndex,
          (action as actionTypes.IAction).payload.workspaceLocation
        )
      );
    }
  });

  yield takeEvery(actionTypes.SAVE_SOURCECAST_DATA, function*(action) {
    const role = yield select((state: IState) => state.session.role!);
    if (role === Role.Student) {
      return yield call(showWarningMessage, 'Only staff can save sourcecast.');
    }
    const { title, description, audio, playbackData } = (action as actionTypes.IAction).payload;
    const tokens = yield select((state: IState) => ({
      accessToken: state.session.accessToken,
      refreshToken: state.session.refreshToken
    }));
    const resp = yield postSourcecast(title, description, audio, playbackData, tokens);
    if (resp && resp.ok) {
      yield call(showSuccessMessage, 'Saved!', 1000);
      yield history.push('/sourcecast');
    } else if (resp !== null) {
      let errorMessage: string;
      switch (resp.status) {
        case 401:
          errorMessage = 'Session expired. Please login again.';
          break;
        default:
          errorMessage = `Something went wrong (got ${resp.status} response)`;
          break;
      }
      yield call(showWarningMessage, errorMessage);
    } else {
      yield call(showWarningMessage, "Couldn't reach our servers. Are you online?");
    }
  });
}

/**
 * POST /auth
 */
export async function postAuth(luminusCode: string): Promise<Tokens | null> {
  const response = await request('auth', 'POST', {
    body: { login: { luminus_code: luminusCode } },
    errorMessage: 'Could not login. Please contact the module administrator.'
  });
  if (response) {
    const tokens = await response.json();
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token
    };
  } else {
    return null;
  }
}

/**
 * POST /auth/refresh
 */
async function postRefresh(refreshToken: string): Promise<Tokens | null> {
  const response = await request('auth/refresh', 'POST', {
    body: { refresh_token: refreshToken }
  });
  if (response) {
    const tokens = await response.json();
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token
    };
  } else {
    return null;
  }
}

/**
 * GET /user
 */
export async function getUser(tokens: Tokens): Promise<object | null> {
  const response = await request('user', 'GET', {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    shouldRefresh: true
  });
  if (response && response.ok) {
    return await response.json();
  } else {
    return null;
  }
}

/**
 * GET /assessments
 */
export async function getAssessmentOverviews(
  tokens: Tokens
): Promise<IAssessmentOverview[] | null> {
  const response = await request('assessments', 'GET', {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    shouldRefresh: true
  });
  if (response && response.ok) {
    const assessmentOverviews = await response.json();
    return assessmentOverviews.map((overview: any) => {
      /**
       * backend has property ->     type: 'mission' | 'sidequest' | 'path' | 'contest'
       *              we have -> category: 'Mission' | 'Sidequest' | 'Path' | 'Contest'
       */
      overview.category = capitalise(overview.type);
      delete overview.type;

      return overview as IAssessmentOverview;
    });
  } else {
    return null; // invalid accessToken _and_ refreshToken
  }
}

/**
 * GET /assessments/${assessmentId}
 */
export async function getAssessment(id: number, tokens: Tokens): Promise<IAssessment | null> {
  const response = await request(`assessments/${id}`, 'GET', {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    shouldRefresh: true
  });
  if (response && response.ok) {
    const assessment = (await response.json()) as IAssessment;
    // backend has property ->     type: 'mission' | 'sidequest' | 'path' | 'contest'
    //              we have -> category: 'Mission' | 'Sidequest' | 'Path' | 'Contest'
    assessment.category = capitalise((assessment as any).type) as AssessmentCategory;
    delete (assessment as any).type;
    assessment.questions = assessment.questions.map(q => {
      if (q.type === QuestionTypes.programming) {
        const question = q as IProgrammingQuestion;
        question.autogradingResults = question.autogradingResults || [];
        question.prepend = question.prepend || '';
        question.postpend = question.postpend || '';
        question.testcases = question.testcases || [];
        q = question;
      }

      // Make library.external.name uppercase
      q.library.external.name = q.library.external.name.toUpperCase() as ExternalLibraryName;
      // Make globals into an Array of (string, value)
      q.library.globals = Object.entries(q.library.globals as object).map(entry => {
        try {
          entry[1] = (window as any).eval(entry[1]);
        } catch (e) {}
        return entry;
      });
      return q;
    });
    return assessment;
  } else {
    return null;
  }
}

/**
 * POST /assessments/question/${questionId}/submit
 */
export async function postAnswer(
  id: number,
  answer: string | number,
  tokens: Tokens
): Promise<Response | null> {
  const resp = await request(`assessments/question/${id}/submit`, 'POST', {
    accessToken: tokens.accessToken,
    body: { answer: `${answer}` },
    noHeaderAccept: true,
    refreshToken: tokens.refreshToken,
    shouldAutoLogout: false,
    shouldRefresh: true
  });
  return resp;
}

/**
 * POST /assessments/${assessmentId}/submit
 */
export async function postAssessment(id: number, tokens: Tokens): Promise<Response | null> {
  const resp = await request(`assessments/${id}/submit`, 'POST', {
    accessToken: tokens.accessToken,
    noHeaderAccept: true,
    refreshToken: tokens.refreshToken,
    shouldAutoLogout: false, // 400 if some questions unattempted
    shouldRefresh: true
  });
  return resp;
}

/*
 * GET /grading
 * @params group - a boolean if true gets the submissions from the grader's group
 * @returns {Array} GradingOverview[]
 */
async function getGradingOverviews(
  tokens: Tokens,
  group: boolean
): Promise<GradingOverview[] | null> {
  const response = await request(`grading?group=${group}`, 'GET', {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    shouldRefresh: true
  });
  if (response) {
    const gradingOverviews = await response.json();
    return gradingOverviews.map((overview: any) => {
      const gradingOverview: GradingOverview = {
        assessmentId: overview.assessment.id,
        assessmentName: overview.assessment.title,
        assessmentCategory: capitalise(overview.assessment.type) as AssessmentCategory,
        studentId: overview.student.id,
        studentName: overview.student.name,
        submissionId: overview.id,
        submissionStatus: overview.status,
        groupName: overview.groupName,
        // Grade
        initialGrade: overview.grade,
        gradeAdjustment: overview.adjustment,
        currentGrade: overview.grade + overview.adjustment,
        maxGrade: overview.assessment.maxGrade,
        gradingStatus: overview.gradingStatus,
        questionCount: overview.questionCount,
        gradedCount: overview.gradedCount,
        // XP
        initialXp: overview.xp,
        xpAdjustment: overview.xpAdjustment,
        currentXp: overview.xp + overview.xpAdjustment,
        maxXp: overview.assessment.maxXp,
        xpBonus: overview.xpBonus
      };
      return gradingOverview;
    });
  } else {
    return null; // invalid accessToken _and_ refreshToken
  }
}

/**
 * GET /grading/${submissionId}
 * @returns {Grading}
 */
async function getGrading(submissionId: number, tokens: Tokens): Promise<Grading | null> {
  const response = await request(`grading/${submissionId}`, 'GET', {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    shouldRefresh: true
  });
  if (response) {
    const gradingResult = await response.json();
    const grading: Grading = gradingResult.map((gradingQuestion: any) => {
      const { student, question, grade } = gradingQuestion;

      return {
        question: {
          answer: question.answer,
          autogradingResults: question.autogradingResults || [],
          choices: question.choices,
          content: question.content,
          roomId: null,
          id: question.id,
          library: castLibrary(question.library),
          solution: gradingQuestion.solution || question.solution || null,
          solutionTemplate: question.solutionTemplate,
          prepend: question.prepend || '',
          postpend: question.postpend || '',
          testcases: question.testcases || [],
          type: question.type as QuestionType,
          maxGrade: question.maxGrade,
          maxXp: question.maxXp
        },
        student,
        grade: {
          grade: grade.grade,
          xp: grade.xp,
          roomId: grade.roomId || '',
          gradeAdjustment: grade.adjustment,
          xpAdjustment: grade.xpAdjustment
        }
      } as GradingQuestion;
    });
    return grading;
  } else {
    return null;
  }
}

/**
 * POST /grading/{submissionId}/{questionId}
 */
const postGrading = async (
  submissionId: number,
  questionId: number,
  gradeAdjustment: number,
  xpAdjustment: number,
  tokens: Tokens
) => {
  const resp = await request(`grading/${submissionId}/${questionId}`, 'POST', {
    accessToken: tokens.accessToken,
    body: {
      grading: {
        adjustment: gradeAdjustment,
        xpAdjustment
      }
    },
    noHeaderAccept: true,
    refreshToken: tokens.refreshToken,
    shouldAutoLogout: false,
    shouldRefresh: true
  });
  return resp;
};

/**
 * POST /grading/{submissionId}/unsubmit
 */
async function postUnsubmit(submissionId: number, tokens: Tokens) {
  const resp = await request(`grading/${submissionId}/unsubmit`, 'POST', {
    accessToken: tokens.accessToken,
    noHeaderAccept: true,
    refreshToken: tokens.refreshToken,
    shouldAutoLogout: false,
    shouldRefresh: true
  });
  return resp;
}

/**
 * GET /notification
 */
export async function getNotifications(tokens: Tokens) {
  const resp: Response | null = await request('notification', 'GET', {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    shouldAutoLogout: false
  });
  let notifications: Notification[] = [];

  if (!resp || !resp.ok) {
    return notifications;
  }

  const result = await resp.json();
  notifications = result.map((notification: any) => {
    return {
      id: notification.id,
      type: notification.type,
      assessment_id: notification.assessment_id || undefined,
      assessment_type: notification.assessment
        ? capitalise(notification.assessment.type)
        : undefined,
      assessment_title: notification.assessment ? notification.assessment.title : undefined,
      submission_id: notification.submission_id || undefined
    } as Notification;
  });

  return notifications;
}

/**
 * POST /notification/acknowledge
 */
export async function postAcknowledgeNotifications(tokens: Tokens, ids: number[]) {
  const resp: Response | null = await request(`notification/acknowledge`, 'POST', {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    body: { notificationIds: ids },
    shouldAutoLogout: false
  });

  return resp;
}

/**
 * POST /chat/notify
 */
export async function postNotify(tokens: Tokens, assessmentId?: number, submissionId?: number) {
  await request(`chat/notify`, 'POST', {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    body: {
      assessmentId,
      submissionId
    },
    shouldAutoLogout: false
  });
}

/**
 * GET /sourcecast
 */
async function getSourcecastIndex(tokens: Tokens): Promise<IAssessmentOverview[] | null> {
  const response = await request('sourcecast', 'GET', {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    shouldRefresh: true
  });
  if (response && response.ok) {
    const index = await response.json();
    return index;
  } else {
    return null;
  }
}

/**
 * POST /sourcecast
 */
const postSourcecast = async (
  title: string,
  description: string,
  audio: Blob,
  playbackData: IPlaybackData,
  tokens: Tokens
) => {
  const formData = new FormData();
  const filename = Date.now().toString() + '.wav';
  formData.append('sourcecast[title]', title);
  formData.append('sourcecast[description]', description);
  formData.append('sourcecast[audio]', audio, filename);
  formData.append('sourcecast[playbackData]', JSON.stringify(playbackData));
  const resp = await request(`sourcecast`, 'POST', {
    accessToken: tokens.accessToken,
    body: formData,
    noContentType: true,
    noHeaderAccept: true,
    refreshToken: tokens.refreshToken,
    shouldAutoLogout: false,
    shouldRefresh: true
  });
  return resp;
};

/**
 * @returns {(Response|null)} Response if successful, otherwise null.
 *
 * @see @type{RequestOptions} for options to this function.
 *
 * If opts.shouldRefresh, an initial response status of < 200 or > 299 will
 * cause this function to call postRefresh to attempt to setToken with fresh
 * tokens.
 *
 * If fetch throws an error, or final response has status code < 200 or > 299,
 * this function will cause the user to logout.
 */
async function request(
  path: string,
  method: string,
  opts: RequestOptions
): Promise<Response | null> {
  const headers = new Headers();
  if (!opts.noHeaderAccept) {
    headers.append('Accept', 'application/json');
  }
  if (opts.accessToken) {
    headers.append('Authorization', `Bearer ${opts.accessToken}`);
  }
  const fetchOpts: any = { method, headers };
  if (opts.body) {
    if (opts.noContentType) {
      fetchOpts.body = opts.body;
    } else {
      headers.append('Content-Type', 'application/json');
      fetchOpts.body = JSON.stringify(opts.body);
    }
  }
  try {
    const response = await fetch(`${BACKEND_URL}/v1/${path}`, fetchOpts);
    // response.ok is (200 <= response.status <= 299)
    // response.status of > 299 does not raise error; so deal with in in the try clause
    if (response && response.ok) {
      return response;
    } else if (opts.shouldRefresh && response.status === 401) {
      const newTokens = await postRefresh(opts.refreshToken!);
      store.dispatch(actions.setTokens(newTokens));
      const newOpts = {
        ...opts,
        accessToken: newTokens!.accessToken,
        shouldRefresh: false
      };
      return request(path, method, newOpts);
    } else if (response && opts.shouldAutoLogout === false) {
      // this clause is mostly for SUBMIT_ANSWER; show an error message instead
      // and ask student to manually logout, so that they have a chance to save
      // their answers
      return response;
    } else {
      throw new Error('API call failed or got non-OK response');
    }
  } catch (e) {
    store.dispatch(actions.logOut());
    showWarningMessage(opts.errorMessage ? opts.errorMessage : 'Please login again.');
    return null;
  }
}

function* handleResponseError(resp: Response | null) {
  if (!resp) {
    yield call(showWarningMessage, "Couldn't reach our servers. Are you online?");
    return;
  }

  let errorMessage: string;
  switch (resp.status) {
    case 401:
      errorMessage = 'Session expired. Please login again.';
      break;
    default:
      errorMessage = `Error ${resp.status}: ${resp.statusText}`;
      break;
  }
  yield call(showWarningMessage, errorMessage);
}

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export default backendSaga;
